import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { scrubbedParentEnv, type SubprocessHandle, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  CodingAgentConfigSnapshot,
  CodingAgentConfigWrite,
  CodingAgentMessage,
  CodingAgentPermission,
  CodingAgentRunRequest,
  CodingAgentSessionDetail,
  CodingAgentSessionMutation,
  CodingAgentSessionQuery,
  CodingAgentSessionSummary,
} from './types.ts'
import { resolveNativePackageExecutable } from './native-executable.ts'

const require = createRequire(import.meta.url)
const codexPackageJson = require.resolve('@openai/codex/package.json')
const codexManifest = JSON.parse(readFileSync(codexPackageJson, 'utf8')) as { version: string }

const CODEX_TARGETS: Record<string, { packageName: string; triple: string }> = {
  'darwin-arm64': { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'darwin-x64': { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'linux-arm64': { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'linux-x64': { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'win32-arm64': { packageName: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
  'win32-x64': { packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
}

const codexTarget = CODEX_TARGETS[`${process.platform}-${process.arch}`]
if (codexTarget === undefined) throw new Error(`Codex 不支持当前平台：${process.platform}-${process.arch}`)
const CODEX_EXECUTABLE = resolveNativePackageExecutable(
  codexTarget.packageName,
  'vendor',
  codexTarget.triple,
  'bin',
  process.platform === 'win32' ? 'codex.exe' : 'codex',
)

type SubprocessFace = Pick<SubprocessRuntime, 'spawn'>

interface CodexHooks {
  signal: AbortSignal
  onSession(sessionId: string): void
  onTurn(turnId: string): void
  onEvent(type: 'status' | 'text' | 'tool' | 'warning' | 'error', text: string, data?: unknown): void
  onOutput(text: string): void
}

interface ActiveTurn {
  threadId: string
  turnId?: string
  hooks: CodexHooks
  completed: Deferred<Record<string, unknown>>
  itemText: Map<string, string>
  finalText: string
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function textOf(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(item => textOf(item, depth + 1)).filter(Boolean).join('\n')
  const row = record(value)
  if (row === undefined) return ''
  for (const key of ['text', 'content', 'message', 'output', 'result']) {
    const valueText = textOf(row[key], depth + 1)
    if (valueText !== '') return valueText
  }
  return ''
}

function sourceLabel(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const row = record(value)
  return stringValue(row?.type) ?? stringValue(row?.kind)
}

function normalizeThread(thread: Record<string, unknown>, archived = false): CodingAgentSessionSummary {
  const id = stringValue(thread.id)
  if (id === undefined) throw new Error('Codex 返回了无效的 thread id')
  const createdAt = typeof thread.createdAt === 'number' ? thread.createdAt * 1_000 : undefined
  const updatedAt = typeof thread.updatedAt === 'number' ? thread.updatedAt * 1_000 : createdAt ?? Date.now()
  const git = record(thread.gitInfo)
  return {
    engine: 'codex',
    id,
    title: stringValue(thread.name) ?? stringValue(thread.preview) ?? '未命名 Codex 会话',
    preview: stringValue(thread.preview) ?? '',
    ...(stringValue(thread.cwd) === undefined ? {} : { cwd: stringValue(thread.cwd) }),
    ...(createdAt === undefined ? {} : { createdAt }),
    updatedAt,
    ...(stringValue(thread.model) === undefined ? {} : { model: stringValue(thread.model) }),
    ...(stringValue(git?.branch) === undefined ? {} : { branch: stringValue(git?.branch) }),
    archived,
    ...(sourceLabel(thread.source) === undefined ? {} : { source: sourceLabel(thread.source) }),
    ...(stringValue(thread.parentThreadId) === undefined ? {} : { parentId: stringValue(thread.parentThreadId) }),
    ...(typeof thread.status === 'string' ? { status: thread.status } : {}),
  }
}

function normalizeItem(item: unknown, index: number): CodingAgentMessage | undefined {
  const row = record(item)
  if (row === undefined) return undefined
  const type = stringValue(row.type) ?? 'item'
  const id = stringValue(row.id) ?? `codex-item-${index}`
  if (type === 'userMessage') return { id, role: 'user', text: textOf(row.content) || textOf(row), kind: type, raw: row }
  if (type === 'agentMessage') return { id, role: 'assistant', text: textOf(row.text) || textOf(row), kind: type, raw: row }
  if (type === 'reasoning') return { id, role: 'system', text: textOf(row.summary) || textOf(row.text), kind: type, raw: row }
  const toolTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch'])
  if (toolTypes.has(type)) return { id, role: 'tool', text: textOf(row) || type, kind: type, raw: row }
  const text = textOf(row)
  return text === '' ? undefined : { id, role: 'system', text, kind: type, raw: row }
}

function threadMessages(thread: Record<string, unknown>): CodingAgentMessage[] {
  const turns = Array.isArray(thread.turns) ? thread.turns : []
  const messages: CodingAgentMessage[] = []
  for (const [turnIndex, turnValue] of turns.entries()) {
    const turn = record(turnValue)
    const items = Array.isArray(turn?.items) ? turn.items : []
    for (const [itemIndex, item] of items.entries()) {
      const normalized = normalizeItem(item, turnIndex * 10_000 + itemIndex)
      if (normalized !== undefined && normalized.text.trim() !== '') messages.push(normalized)
    }
  }
  return messages
}

function codexPolicy(permission: CodingAgentPermission): { approvalPolicy: 'never'; sandbox: 'read-only' | 'workspace-write' | 'danger-full-access' } {
  return {
    approvalPolicy: 'never',
    sandbox: permission === 'full-access' ? 'danger-full-access' : permission,
  }
}

export class CodexController {
  readonly version = codexManifest.version
  readonly executable = CODEX_EXECUTABLE
  readonly dataDirectory = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  readonly configFile = join(this.dataDirectory, 'config.toml')
  #child?: SubprocessHandle
  #transport?: JsonRpcLineTransport
  #initializing?: Promise<void>
  #closed = false
  readonly #activeByThread = new Map<string, ActiveTurn>()

  constructor(private readonly subprocess: SubprocessFace) {}

  async #ensure(): Promise<JsonRpcLineTransport> {
    if (this.#closed) throw new Error('Codex 控制器已经关闭')
    if (this.#transport !== undefined) return this.#transport
    if (this.#initializing !== undefined) {
      await this.#initializing
      return this.#transport!
    }
    this.#initializing = this.#start()
    try {
      await this.#initializing
      return this.#transport!
    } finally {
      this.#initializing = undefined
    }
  }

  async #start(): Promise<void> {
    const child = this.subprocess.spawn({
      argv: [CODEX_EXECUTABLE, 'app-server', '--stdio'],
      cwd: process.cwd(),
      env: scrubbedParentEnv(),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: 3_000,
    })
    if (child.stdout === undefined || child.stdin === undefined) {
      child.terminate()
      throw new Error('Codex App Server 没有提供协议管道')
    }
    const transport = this.#createTransport(child.stdout, child.stdin)
    this.#child = child
    this.#transport = transport
    transport.start()
    try {
      await Promise.race([
        transport.request('initialize', {
          clientInfo: { name: 'dsh-coding-agents', title: 'DSH 编程助手', version: '0.1.0' },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }),
        child.done.then(result => Promise.reject(new Error(`Codex App Server 提前退出（${String(result.exitCode)}）`))),
      ])
      transport.notify('initialized')
      await transport.flush()
    } catch (error) {
      transport.close()
      child.terminate()
      this.#transport = undefined
      this.#child = undefined
      throw error
    }
    void child.done.then(() => {
      if (this.#child !== child) return
      this.#transport = undefined
      this.#child = undefined
      for (const active of this.#activeByThread.values()) active.completed.reject(new Error('Codex App Server 已退出'))
      this.#activeByThread.clear()
    }, () => {})
  }

  #createTransport(input: Readable, output: Writable): JsonRpcLineTransport {
    const transport = new JsonRpcLineTransport(input, output)
    transport.onNotification((method, params) => { this.#notification(method, params) })
    transport.onRequest((method, params) => this.#serverRequest(method, params))
    return transport
  }

  #notification(method: string, params: Record<string, unknown>): void {
    const threadId = stringValue(params.threadId) ?? stringValue(record(params.thread)?.id)
    if (threadId === undefined) return
    const active = this.#activeByThread.get(threadId)
    if (active === undefined) return
    const turnId = stringValue(params.turnId) ?? stringValue(record(params.turn)?.id)
    if (turnId !== undefined && active.turnId === undefined) {
      active.turnId = turnId
      active.hooks.onTurn(turnId)
    }
    if (method === 'warning' || method === 'guardianWarning' || method === 'configWarning' || method === 'deprecationNotice') {
      active.hooks.onEvent('warning', stringValue(params.message) ?? JSON.stringify(params))
      return
    }
    if (method === 'error') {
      active.hooks.onEvent('error', stringValue(record(params.error)?.message) ?? stringValue(params.message) ?? 'Codex 执行错误', params)
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = record(params.item)
      if (item === undefined) return
      const type = stringValue(item.type) ?? 'item'
      const id = stringValue(item.id) ?? type
      if (type === 'agentMessage' && method === 'item/completed') {
        const text = stringValue(item.text) ?? active.itemText.get(id) ?? ''
        if (item.phase === 'final_answer' || item.phase === null || item.phase === undefined) {
          active.finalText = text
          active.hooks.onOutput(text)
        } else if (text !== '') active.hooks.onEvent('text', text, item)
        active.itemText.delete(id)
        return
      }
      if (!['userMessage', 'reasoning', 'agentMessage'].includes(type)) {
        active.hooks.onEvent('tool', `${method === 'item/started' ? '开始' : '完成'}：${type}`, item)
      }
      return
    }
    if (method === 'item/agentMessage/delta') {
      const itemId = stringValue(params.itemId)
      const delta = stringValue(params.delta)
      if (itemId !== undefined && delta !== undefined) active.itemText.set(itemId, `${active.itemText.get(itemId) ?? ''}${delta}`)
      return
    }
    if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
      const delta = stringValue(params.delta)
      if (delta !== undefined) active.hooks.onEvent('tool', delta, { method, ...params })
      return
    }
    if (method === 'turn/completed') {
      const turn = record(params.turn)
      if (turn !== undefined) active.completed.resolve(turn)
    }
  }

  async #serverRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'currentTime/read') return { currentTimeAt: Math.floor(Date.now() / 1_000) }
    if (method === 'item/tool/requestUserInput') return { answers: {} }
    if (method === 'mcpServer/elicitation/request') return { action: 'decline' }
    if (method === 'item/tool/call') return { contentItems: [{ type: 'inputText', text: 'DSH 未注册此动态工具。' }], success: false }
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' }
    if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' }
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: { denied: { rejection: '当前运行未授权额外权限。' } } }
    throw new Error(`DSH 暂不支持 Codex 服务请求 ${method}: ${JSON.stringify(params)}`)
  }

  async list(query: CodingAgentSessionQuery): Promise<CodingAgentSessionSummary[]> {
    const transport = await this.#ensure()
    const limit = Math.min(200, Math.max(1, Math.floor(query.limit ?? 50)))
    const response = record(await transport.request('thread/list', {
      limit,
      archived: query.archived ?? false,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      ...(query.query?.trim() ? { searchTerm: query.query.trim() } : {}),
      ...(query.cwd?.trim() ? { cwd: query.cwd.trim() } : {}),
    }))
    const data = Array.isArray(response?.data) ? response.data : []
    return data.flatMap((item) => {
      const thread = record(item)
      return thread === undefined ? [] : [normalizeThread(thread, query.archived === true)]
    }).slice(Math.max(0, query.offset ?? 0))
  }

  async detail(sessionId: string, limit = 500, offset?: number): Promise<CodingAgentSessionDetail> {
    const transport = await this.#ensure()
    const response = record(await transport.request('thread/read', { threadId: sessionId, includeTurns: true }))
    const thread = record(response?.thread)
    if (thread === undefined) throw new Error('Codex 会话不存在或无法读取')
    const all = threadMessages(thread)
    const pageSize = Math.min(2_000, Math.max(1, Math.floor(limit)))
    const start = Math.min(all.length, Math.max(0, offset === undefined ? all.length - pageSize : Math.floor(offset)))
    return {
      ...normalizeThread(thread),
      messages: all.slice(start, start + pageSize),
      totalMessageCount: all.length,
      messageOffset: start,
      hasMoreBefore: start > 0,
      hasMoreAfter: start + pageSize < all.length,
      raw: thread,
    }
  }

  async config(cwd?: string): Promise<CodingAgentConfigSnapshot> {
    const transport = await this.#ensure()
    const response = record(await transport.request('config/read', {
      includeLayers: true,
      ...(cwd === undefined || cwd.trim() === '' ? {} : { cwd }),
    }))
    const config = record(response?.config) ?? {}
    const layers = Array.isArray(response?.layers) ? response.layers : []
    return {
      engine: 'codex',
      ...(cwd === undefined ? {} : { cwd }),
      effective: config,
      sources: layers.flatMap((value) => {
        const layer = record(value)
        if (layer === undefined) return []
        const name = record(layer.name) ?? record(layer.source)
        return [{
          kind: stringValue(name?.type) ?? 'unknown',
          ...(stringValue(name?.file) === undefined ? {} : { path: stringValue(name?.file) }),
          ...(stringValue(layer.version) === undefined ? {} : { version: stringValue(layer.version) }),
          ...(record(layer.config) === undefined ? {} : { value: record(layer.config) }),
        }]
      }),
      editableTargets: [{ id: 'user', label: '用户配置', path: this.configFile }],
    }
  }

  async writeConfig(change: CodingAgentConfigWrite): Promise<CodingAgentConfigSnapshot> {
    if (change.remove === true) throw new Error('Codex 官方配置协议不支持无歧义删除，请把该配置项改为默认值')
    if (change.target !== undefined && change.target !== 'user') throw new Error('Codex 当前仅允许修改用户配置')
    const transport = await this.#ensure()
    await transport.request('config/value/write', {
      keyPath: change.keyPath,
      value: change.value,
      mergeStrategy: 'upsert',
    })
    return this.config(change.cwd)
  }

  async mutate(change: CodingAgentSessionMutation): Promise<{ sessionId: string }> {
    const transport = await this.#ensure()
    if (change.action === 'rename') {
      if (change.title?.trim() === '') throw new Error('会话名称不能为空')
      await transport.request('thread/name/set', { threadId: change.sessionId, name: change.title })
      return { sessionId: change.sessionId }
    }
    if (change.action === 'archive' || change.action === 'unarchive' || change.action === 'delete') {
      await transport.request(`thread/${change.action}`, { threadId: change.sessionId })
      return { sessionId: change.sessionId }
    }
    if (change.action === 'rollback') {
      await transport.request('thread/rollback', { threadId: change.sessionId, numTurns: Math.max(1, change.turns ?? 1) })
      return { sessionId: change.sessionId }
    }
    if (change.action === 'fork') {
      const response = record(await transport.request('thread/fork', {
        threadId: change.sessionId,
        ephemeral: false,
        excludeTurns: true,
      }))
      const threadId = stringValue(record(response?.thread)?.id)
      if (threadId === undefined) throw new Error('Codex 未返回分叉会话 ID')
      return { sessionId: threadId }
    }
    throw new Error(`Codex 不支持会话操作 ${change.action}`)
  }

  async execute(request: CodingAgentRunRequest, hooks: CodexHooks): Promise<{ sessionId: string; turnId: string; output: string }> {
    const transport = await this.#ensure()
    const permission = request.permission ?? 'workspace-write'
    const policy = codexPolicy(permission)
    let response: Record<string, unknown> | undefined
    if (request.mode === 'new') {
      response = record(await transport.request('thread/start', {
        cwd: request.cwd,
        ephemeral: false,
        ...policy,
        ...(request.model === undefined ? {} : { model: request.model }),
      }, hooks.signal))
    } else if (request.mode === 'resume') {
      if (request.sessionId === undefined) throw new Error('继续 Codex 会话需要 sessionId')
      response = record(await transport.request('thread/resume', {
        threadId: request.sessionId,
        excludeTurns: true,
        cwd: request.cwd,
        ...policy,
        ...(request.model === undefined ? {} : { model: request.model }),
      }, hooks.signal))
    } else {
      if (request.sessionId === undefined) throw new Error('分叉 Codex 会话需要 sessionId')
      response = record(await transport.request('thread/fork', {
        threadId: request.sessionId,
        excludeTurns: true,
        ephemeral: false,
        cwd: request.cwd,
        ...policy,
        ...(request.model === undefined ? {} : { model: request.model }),
      }, hooks.signal))
    }
    const threadId = stringValue(record(response?.thread)?.id)
    if (threadId === undefined) throw new Error('Codex 未返回会话 ID')
    hooks.onSession(threadId)
    const active: ActiveTurn = {
      threadId,
      hooks,
      completed: deferred<Record<string, unknown>>(),
      itemText: new Map(),
      finalText: '',
    }
    this.#activeByThread.set(threadId, active)
    const abort = (): void => {
      if (active.turnId === undefined) return
      void transport.request('turn/interrupt', { threadId, turnId: active.turnId }).catch(() => {})
    }
    hooks.signal.addEventListener('abort', abort, { once: true })
    try {
      const started = record(await transport.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: request.prompt, text_elements: [] }],
        ...(request.effort === undefined ? {} : { effort: request.effort }),
      }, hooks.signal))
      const turnId = stringValue(record(started?.turn)?.id)
      if (turnId === undefined) throw new Error('Codex 未返回 turn ID')
      active.turnId = turnId
      hooks.onTurn(turnId)
      hooks.onEvent('status', request.mode === 'new' ? 'Codex 新会话已开始' : request.mode === 'fork' ? 'Codex 分叉会话已开始' : 'Codex 会话已继续')
      const completed = await active.completed.promise
      const status = stringValue(completed.status)
      if (status !== 'completed') throw new Error(`Codex 本轮状态：${status ?? 'unknown'}`)
      return { sessionId: threadId, turnId, output: active.finalText }
    } finally {
      hooks.signal.removeEventListener('abort', abort)
      this.#activeByThread.delete(threadId)
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#transport?.close()
    this.#transport = undefined
    const child = this.#child
    this.#child = undefined
    if (child === undefined) return
    try { child.stdin?.end() } catch {}
    child.terminate()
    await child.done.catch(() => {})
  }
}
