import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CodingAgentsManager } from './manager.ts'
import type {
  CodingAgentConfigWrite,
  CodingAgentEngine,
  CodingAgentRunRequest,
  CodingAgentSessionMutation,
  CodingAgentSessionQuery,
} from './types.ts'

export const CODING_AGENTS_API_PREFIX = '/coding-agents-api'
const MAX_BODY_BYTES = 1024 * 1024

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function engine(value: unknown): CodingAgentEngine {
  if (value === 'codex' || value === 'claude-code') return value
  throw new Error('engine 必须是 codex 或 claude-code')
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function requiredString(value: unknown, name: string): string {
  const text = optionalString(value)
  if (text === undefined) throw new Error(`${name} 不能为空`)
  return text
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体超过 1 MiB')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try { return JSON.parse(text) } catch { throw new Error('请求体不是合法 JSON') }
}

function send(response: ServerResponse, body: unknown, status = 200): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

function runRequest(value: unknown): CodingAgentRunRequest {
  const body = record(value)
  if (body === undefined) throw new Error('运行请求必须是对象')
  const mode = body.mode
  if (mode !== 'new' && mode !== 'resume' && mode !== 'fork') throw new Error('mode 必须是 new、resume 或 fork')
  const permission = body.permission
  if (permission !== undefined && permission !== 'read-only' && permission !== 'workspace-write' && permission !== 'full-access') {
    throw new Error('permission 无效')
  }
  return {
    engine: engine(body.engine),
    mode,
    prompt: requiredString(body.prompt, 'prompt'),
    ...(optionalString(body.cwd) === undefined ? {} : { cwd: optionalString(body.cwd) }),
    ...(optionalString(body.sessionId) === undefined ? {} : { sessionId: optionalString(body.sessionId) }),
    ...(optionalString(body.model) === undefined ? {} : { model: optionalString(body.model) }),
    ...(optionalString(body.effort) === undefined ? {} : { effort: optionalString(body.effort) }),
    ...(permission === undefined ? {} : { permission }),
  }
}

function mutation(value: unknown): CodingAgentSessionMutation {
  const body = record(value)
  if (body === undefined) throw new Error('会话操作必须是对象')
  const action = body.action
  if (!['rename', 'tag', 'archive', 'unarchive', 'fork', 'rollback', 'delete'].includes(String(action))) throw new Error('action 无效')
  return {
    engine: engine(body.engine),
    sessionId: requiredString(body.sessionId, 'sessionId'),
    action: action as CodingAgentSessionMutation['action'],
    ...(optionalString(body.cwd) === undefined ? {} : { cwd: optionalString(body.cwd) }),
    ...(optionalString(body.title) === undefined ? {} : { title: optionalString(body.title) }),
    ...(body.tag === null ? { tag: null } : optionalString(body.tag) === undefined ? {} : { tag: optionalString(body.tag) }),
    ...(optionalString(body.upToMessageId) === undefined ? {} : { upToMessageId: optionalString(body.upToMessageId) }),
    ...(typeof body.turns === 'number' ? { turns: Math.max(1, Math.floor(body.turns)) } : {}),
  }
}

function configWrite(value: unknown): CodingAgentConfigWrite {
  const body = record(value)
  if (body === undefined) throw new Error('配置修改必须是对象')
  return {
    engine: engine(body.engine),
    keyPath: requiredString(body.keyPath, 'keyPath'),
    value: body.value,
    ...(optionalString(body.cwd) === undefined ? {} : { cwd: optionalString(body.cwd) }),
    ...(optionalString(body.target) === undefined ? {} : { target: optionalString(body.target) }),
    ...(body.remove === true ? { remove: true } : {}),
  }
}

export function createCodingAgentsRoute(manager: CodingAgentsManager) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? CODING_AGENTS_API_PREFIX, 'http://dsh.local')
      const path = url.pathname.startsWith(CODING_AGENTS_API_PREFIX)
        ? url.pathname.slice(CODING_AGENTS_API_PREFIX.length) || '/'
        : url.pathname
      const method = (request.method ?? 'GET').toUpperCase()
      if (method === 'GET' && path === '/status') {
        send(response, { ok: true, installations: manager.installations(), running: manager.runningCount(), maximumConcurrentRuns: manager.maximumConcurrentRuns })
        return
      }
      if (method === 'GET' && path === '/sessions') {
        const requestedEngine = url.searchParams.get('engine') ?? 'all'
        if (!['all', 'codex', 'claude-code'].includes(requestedEngine)) throw new Error('engine 无效')
        const query: CodingAgentSessionQuery = {
          engine: requestedEngine as CodingAgentSessionQuery['engine'],
          ...(optionalString(url.searchParams.get('query')) === undefined ? {} : { query: optionalString(url.searchParams.get('query')) }),
          ...(optionalString(url.searchParams.get('cwd')) === undefined ? {} : { cwd: optionalString(url.searchParams.get('cwd')) }),
          limit: Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50))),
          offset: Math.max(0, Number(url.searchParams.get('offset') ?? 0)),
          archived: url.searchParams.get('archived') === 'true',
        }
        send(response, { ok: true, sessions: await manager.list(query) })
        return
      }
      const sessionMatch = /^\/sessions\/(codex|claude-code)\/([^/]+)$/u.exec(path)
      if (method === 'GET' && sessionMatch !== null) {
        const limit = Math.min(2_000, Math.max(1, Number(url.searchParams.get('limit') ?? 500)))
        const rawOffset = url.searchParams.get('offset')
        send(response, { ok: true, session: await manager.detail(
          engine(sessionMatch[1]),
          decodeURIComponent(sessionMatch[2]!),
          optionalString(url.searchParams.get('cwd')),
          limit,
          rawOffset === null ? undefined : Math.max(0, Number(rawOffset)),
        ) })
        return
      }
      if (method === 'POST' && path === '/sessions/mutate') {
        send(response, { ok: true, result: await manager.mutate(mutation(await jsonBody(request))) })
        return
      }
      const configMatch = /^\/config\/(codex|claude-code)$/u.exec(path)
      if (method === 'GET' && configMatch !== null) {
        send(response, { ok: true, config: await manager.config(engine(configMatch[1]), optionalString(url.searchParams.get('cwd'))) })
        return
      }
      if (method === 'POST' && path === '/config') {
        send(response, { ok: true, config: await manager.writeConfig(configWrite(await jsonBody(request))) })
        return
      }
      if (method === 'GET' && path === '/runs') {
        send(response, { ok: true, runs: manager.runs() })
        return
      }
      if (method === 'POST' && path === '/runs') {
        send(response, { ok: true, run: manager.start(runRequest(await jsonBody(request))) })
        return
      }
      const runMatch = /^\/runs\/([^/]+)$/u.exec(path)
      if (method === 'GET' && runMatch !== null) {
        const run = manager.run(decodeURIComponent(runMatch[1]!), Math.max(0, Number(url.searchParams.get('after') ?? 0)))
        send(response, run === undefined ? { ok: false, code: 'NOT_FOUND', hint: '任务不存在或已被清理' } : { ok: true, run })
        return
      }
      const cancelMatch = /^\/runs\/([^/]+)\/cancel$/u.exec(path)
      if (method === 'POST' && cancelMatch !== null) {
        send(response, { ok: true, run: manager.cancel(decodeURIComponent(cancelMatch[1]!)) })
        return
      }
      send(response, { ok: false, code: 'NOT_FOUND', hint: '接口不存在' }, 404)
    } catch (error) {
      send(response, { ok: false, code: 'INVALID_REQUEST', hint: error instanceof Error ? error.message : String(error) })
    }
  }
}
