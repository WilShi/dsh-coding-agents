import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, relative, resolve } from 'node:path'
import type { CodingAgentsManager } from './manager.ts'
import type {
  CodingAgentConfigWrite,
  CodingAgentEngine,
  CodingAgentPermission,
  CodingAgentRunRequest,
  CodingAgentSessionMutation,
  CodingAgentSessionQuery,
} from './types.ts'

export const CODING_AGENTS_API_PREFIX = '/coding-agents-api'
const MAX_BODY_BYTES = 1024 * 1024

/** TCP peer addresses that count as "this machine". */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
/** Host names an in-page origin may carry for a loopback listener. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Permissions the HTTP surface may request. `full-access` is intentionally
 * absent: bypassing the vendor permission system is only reachable from the
 * DSH UI or from a model tool call the user confirmed inside DSH.
 */
const HTTP_PERMISSIONS: readonly CodingAgentPermission[] = ['read-only', 'workspace-write']

/**
 * Configuration keys the HTTP surface may write, per engine. Anything else —
 * MCP servers, hooks, permission presets, arbitrary nesting — has to go through
 * the DSH UI or a manual file edit.
 */
const WRITABLE_CONFIG_KEYS: Record<CodingAgentEngine, readonly string[]> = {
  codex: ['model', 'model_reasoning_effort'],
  'claude-code': ['permissions.defaultMode'],
}

/** One request-level failure with the HTTP status and stable machine code to report. */
export class CodingAgentsApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'CodingAgentsApiError'
  }
}

/** Host-supplied view of the registered workspaces that bound every `cwd`. */
export interface CodingAgentsRouteOptions {
  /**
   * Registered workspace roots, read per request. Returning `undefined` means
   * the host composition exposes no workspace registry, in which case every
   * request carrying a `cwd` is refused instead of trusting the caller.
   */
  readonly workspaceRoots?: () => readonly string[] | undefined
}

function invalid(message: string): never {
  throw new CodingAgentsApiError(400, 'INVALID_REQUEST', message)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function engine(value: unknown): CodingAgentEngine {
  if (value === 'codex' || value === 'claude-code') return value
  invalid('engine 必须是 codex 或 claude-code')
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function requiredString(value: unknown, name: string): string {
  const text = optionalString(value)
  if (text === undefined) invalid(`${name} 不能为空`)
  return text
}

/** Whether `target` resolves to `base` itself or to a path below it. */
function isPathInside(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Loopback-only transport check: the desktop web server is a local surface and
 * nothing behind a network interface may drive the local coding agents.
 * @param request - inbound request.
 * @returns whether the TCP peer is this machine.
 */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  return LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? '')
}

/**
 * Same-origin guard for browser callers. An `Origin` header must name the
 * exact `http://<host>` the request was sent to (loopback only); without one,
 * the browser's `Sec-Fetch-Site` must be absent, `same-origin` or `none`.
 * Cross-site pages therefore cannot drive this API even with a "simple"
 * request that skips the CORS preflight.
 * @param request - inbound request.
 * @returns whether the request may reach the API.
 */
export function isSameOriginRequest(request: IncomingMessage): boolean {
  if (!isLoopbackRequest(request)) return false
  const host = typeof request.headers.host === 'string' ? request.headers.host.toLowerCase() : ''
  if (host === '') return false
  const origin = request.headers.origin
  if (typeof origin === 'string') {
    try {
      const parsed = new URL(origin)
      const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
      return parsed.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(hostname) && parsed.host.toLowerCase() === host
    } catch {
      return false
    }
  }
  const fetchSite = typeof request.headers['sec-fetch-site'] === 'string'
    ? request.headers['sec-fetch-site'].toLowerCase()
    : ''
  return fetchSite === '' || fetchSite === 'same-origin' || fetchSite === 'none'
}

/** Whether a request declares a JSON body. */
export function isJsonRequest(request: IncomingMessage): boolean {
  const value = request.headers['content-type']
  return typeof value === 'string' && value.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.end(JSON.stringify(body))
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > MAX_BODY_BYTES) invalid('请求体超过 1 MiB')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try { return JSON.parse(text) } catch { invalid('请求体不是合法 JSON') }
}

/** Resolve one optional `cwd` to an absolute path inside a registered workspace. */
function createWorkspaceResolver(options: CodingAgentsRouteOptions): (value: unknown) => string | undefined {
  return (value) => {
    const requested = optionalString(value)
    if (requested === undefined) return undefined
    const roots = options.workspaceRoots?.()
    if (roots === undefined || roots.length === 0) {
      throw new CodingAgentsApiError(400, 'WORKSPACE_UNVERIFIABLE', '无法确认工作区范围：宿主未提供 workspace 注册表。请在 DSH 界面中选择已注册的工作区后重试。')
    }
    const absolute = resolve(requested)
    if (!roots.some(root => isPathInside(root, absolute))) {
      throw new CodingAgentsApiError(400, 'WORKSPACE_OUT_OF_SCOPE', `工作区不在已注册 workspace 内：${requested}。请在 DSH 界面中把该目录添加为工作区后重试。`)
    }
    return absolute
  }
}

/** Validate the HTTP permission ceiling: `full-access` is never accepted here. */
function httpPermission(value: unknown): CodingAgentPermission | undefined {
  if (value === undefined) return undefined
  if (value === 'full-access') {
    throw new CodingAgentsApiError(
      400,
      'PERMISSION_FULL_ACCESS_BLOCKED',
      'HTTP 接口不提供 full-access（完全访问）。需要完全访问时，请在 DSH 界面中手动启动任务，或让模型调用 coding_agent_run 并在 DSH 内逐次确认。',
    )
  }
  if (typeof value === 'string' && HTTP_PERMISSIONS.includes(value as CodingAgentPermission)) {
    return value as CodingAgentPermission
  }
  invalid('permission 必须是 read-only 或 workspace-write')
}

function runRequest(value: unknown, resolveCwd: (value: unknown) => string | undefined): CodingAgentRunRequest {
  const body = record(value)
  if (body === undefined) invalid('运行请求必须是对象')
  const mode = body.mode
  if (mode !== 'new' && mode !== 'resume' && mode !== 'fork') invalid('mode 必须是 new、resume 或 fork')
  const cwd = resolveCwd(body.cwd)
  const permission = httpPermission(body.permission)
  return {
    engine: engine(body.engine),
    mode,
    prompt: requiredString(body.prompt, 'prompt'),
    ...(cwd === undefined ? {} : { cwd }),
    ...(optionalString(body.sessionId) === undefined ? {} : { sessionId: optionalString(body.sessionId) }),
    ...(optionalString(body.model) === undefined ? {} : { model: optionalString(body.model) }),
    ...(optionalString(body.effort) === undefined ? {} : { effort: optionalString(body.effort) }),
    ...(permission === undefined ? {} : { permission }),
  }
}

function mutation(value: unknown, resolveCwd: (value: unknown) => string | undefined): CodingAgentSessionMutation {
  const body = record(value)
  if (body === undefined) invalid('会话操作必须是对象')
  const action = body.action
  if (!['rename', 'tag', 'archive', 'unarchive', 'fork', 'rollback', 'delete'].includes(String(action))) invalid('action 无效')
  const cwd = resolveCwd(body.cwd)
  return {
    engine: engine(body.engine),
    sessionId: requiredString(body.sessionId, 'sessionId'),
    action: action as CodingAgentSessionMutation['action'],
    ...(cwd === undefined ? {} : { cwd }),
    ...(optionalString(body.title) === undefined ? {} : { title: optionalString(body.title) }),
    ...(body.tag === null ? { tag: null } : optionalString(body.tag) === undefined ? {} : { tag: optionalString(body.tag) }),
    ...(optionalString(body.upToMessageId) === undefined ? {} : { upToMessageId: optionalString(body.upToMessageId) }),
    ...(typeof body.turns === 'number' ? { turns: Math.max(1, Math.floor(body.turns)) } : {}),
  }
}

function configWrite(value: unknown, resolveCwd: (value: unknown) => string | undefined): CodingAgentConfigWrite {
  const body = record(value)
  if (body === undefined) invalid('配置修改必须是对象')
  const selected = engine(body.engine)
  const keyPath = requiredString(body.keyPath, 'keyPath')
  const allowed = WRITABLE_CONFIG_KEYS[selected]
  if (!allowed.includes(keyPath)) {
    throw new CodingAgentsApiError(
      400,
      'CONFIG_KEY_NOT_ALLOWED',
      `HTTP 接口只允许修改 ${selected} 的以下配置键：${allowed.join('、')}。其他配置请使用 DSH 界面或直接编辑配置文件。`,
    )
  }
  const cwd = resolveCwd(body.cwd)
  return {
    engine: selected,
    keyPath,
    value: body.value,
    ...(cwd === undefined ? {} : { cwd }),
    ...(optionalString(body.target) === undefined ? {} : { target: optionalString(body.target) }),
    ...(body.remove === true ? { remove: true } : {}),
  }
}

export function createCodingAgentsRoute(manager: CodingAgentsManager, options: CodingAgentsRouteOptions = {}) {
  const resolveCwd = createWorkspaceResolver(options)
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = (request.method ?? 'GET').toUpperCase()
    if (method === 'OPTIONS') {
      send(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', hint: '编程助手接口不支持 OPTIONS / CORS 预检' })
      return
    }
    if (!isSameOriginRequest(request)) {
      send(response, 403, { ok: false, code: 'CROSS_ORIGIN_REJECTED', hint: '编程助手接口只接受本机同源请求' })
      return
    }
    if (method !== 'GET' && method !== 'HEAD' && !isJsonRequest(request)) {
      send(response, 415, { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', hint: 'POST 请求必须使用 content-type: application/json' })
      return
    }
    try {
      const url = new URL(request.url ?? CODING_AGENTS_API_PREFIX, 'http://dsh.local')
      const path = url.pathname.startsWith(CODING_AGENTS_API_PREFIX)
        ? url.pathname.slice(CODING_AGENTS_API_PREFIX.length) || '/'
        : url.pathname
      if (method === 'GET' && path === '/status') {
        send(response, 200, { ok: true, installations: await manager.installations(), running: manager.runningCount(), maximumConcurrentRuns: manager.maximumConcurrentRuns })
        return
      }
      if (method === 'GET' && path === '/sessions') {
        const requestedEngine = url.searchParams.get('engine') ?? 'all'
        if (!['all', 'codex', 'claude-code'].includes(requestedEngine)) invalid('engine 无效')
        const query: CodingAgentSessionQuery = {
          engine: requestedEngine as CodingAgentSessionQuery['engine'],
          ...(optionalString(url.searchParams.get('query')) === undefined ? {} : { query: optionalString(url.searchParams.get('query')) }),
          ...(resolveCwd(url.searchParams.get('cwd')) === undefined ? {} : { cwd: resolveCwd(url.searchParams.get('cwd')) }),
          limit: Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50))),
          offset: Math.max(0, Number(url.searchParams.get('offset') ?? 0)),
          archived: url.searchParams.get('archived') === 'true',
        }
        send(response, 200, { ok: true, sessions: await manager.list(query) })
        return
      }
      const sessionMatch = /^\/sessions\/(codex|claude-code)\/([^/]+)$/u.exec(path)
      if (method === 'GET' && sessionMatch !== null) {
        const limit = Math.min(2_000, Math.max(1, Number(url.searchParams.get('limit') ?? 500)))
        const rawOffset = url.searchParams.get('offset')
        send(response, 200, { ok: true, session: await manager.detail(
          engine(sessionMatch[1]),
          decodeURIComponent(sessionMatch[2]!),
          resolveCwd(url.searchParams.get('cwd')),
          limit,
          rawOffset === null ? undefined : Math.max(0, Number(rawOffset)),
        ) })
        return
      }
      if (method === 'POST' && path === '/sessions/mutate') {
        send(response, 200, { ok: true, result: await manager.mutate(mutation(await jsonBody(request), resolveCwd)) })
        return
      }
      const configMatch = /^\/config\/(codex|claude-code)$/u.exec(path)
      if (method === 'GET' && configMatch !== null) {
        send(response, 200, { ok: true, config: await manager.config(engine(configMatch[1]), resolveCwd(url.searchParams.get('cwd'))) })
        return
      }
      if (method === 'POST' && path === '/config') {
        send(response, 200, { ok: true, config: await manager.writeConfig(configWrite(await jsonBody(request), resolveCwd)) })
        return
      }
      if (method === 'GET' && path === '/runs') {
        send(response, 200, { ok: true, runs: manager.runs() })
        return
      }
      if (method === 'POST' && path === '/runs') {
        send(response, 200, { ok: true, run: manager.start(runRequest(await jsonBody(request), resolveCwd)) })
        return
      }
      const runMatch = /^\/runs\/([^/]+)$/u.exec(path)
      if (method === 'GET' && runMatch !== null) {
        const run = manager.run(decodeURIComponent(runMatch[1]!), Math.max(0, Number(url.searchParams.get('after') ?? 0)))
        send(response, run === undefined ? 404 : 200, run === undefined ? { ok: false, code: 'NOT_FOUND', hint: '任务不存在或已被清理' } : { ok: true, run })
        return
      }
      const cancelMatch = /^\/runs\/([^/]+)\/cancel$/u.exec(path)
      if (method === 'POST' && cancelMatch !== null) {
        send(response, 200, { ok: true, run: manager.cancel(decodeURIComponent(cancelMatch[1]!)) })
        return
      }
      send(response, 404, { ok: false, code: 'NOT_FOUND', hint: '接口不存在' })
    } catch (error) {
      if (error instanceof CodingAgentsApiError) {
        send(response, error.status, { ok: false, code: error.code, hint: error.message })
        return
      }
      send(response, 500, { ok: false, code: 'INTERNAL', hint: '编程助手接口内部错误，请查看 DSH 日志。' })
    }
  }
}
