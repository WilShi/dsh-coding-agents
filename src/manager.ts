import { randomUUID } from 'node:crypto'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { ClaudeController } from './claude-controller.ts'
import { CodexController } from './codex-controller.ts'
import type {
  CodingAgentConfigSnapshot,
  CodingAgentConfigWrite,
  CodingAgentEngine,
  CodingAgentInstallation,
  CodingAgentRunEvent,
  CodingAgentRunRequest,
  CodingAgentRunSnapshot,
  CodingAgentSessionDetail,
  CodingAgentSessionMutation,
  CodingAgentSessionQuery,
  CodingAgentSessionSummary,
} from './types.ts'

type SubprocessFace = Pick<SubprocessRuntime, 'spawn'>

interface ActiveRun {
  snapshot: CodingAgentRunSnapshot
  controller: AbortController
  promise: Promise<CodingAgentRunSnapshot>
  eventSeq: number
}

const MAX_EVENTS = 500
const MAX_RETAINED_RUNS = 100

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function copySnapshot(snapshot: CodingAgentRunSnapshot, afterSeq = 0): CodingAgentRunSnapshot {
  return { ...snapshot, events: snapshot.events.filter(event => event.seq > afterSeq).map(event => ({ ...event })) }
}

export class CodingAgentsManager {
  readonly codex: CodexController
  readonly claude: ClaudeController
  readonly #runs = new Map<string, ActiveRun>()
  #disposed = false

  constructor(subprocess: SubprocessFace, readonly maximumConcurrentRuns = 4) {
    this.codex = new CodexController(subprocess)
    this.claude = new ClaudeController(subprocess)
  }

  installations(): CodingAgentInstallation[] {
    return [
      {
        engine: 'codex',
        label: 'Codex',
        available: true,
        version: this.codex.version,
        executable: this.codex.executable,
        dataDirectory: this.codex.dataDirectory,
        configFile: this.codex.configFile,
        diagnostic: '使用 DSH 内置的官方 Codex App Server，读取并管理当前用户的 Codex 会话。',
      },
      {
        engine: 'claude-code',
        label: 'Claude Code',
        available: true,
        version: this.claude.version,
        executable: this.claude.executable,
        dataDirectory: this.claude.dataDirectory,
        configFile: this.claude.configFile,
        diagnostic: `使用官方 Claude Agent SDK ${this.claude.sdkVersion}，读取并管理当前用户的 Claude Code 会话。`,
      },
    ]
  }

  async list(query: CodingAgentSessionQuery): Promise<CodingAgentSessionSummary[]> {
    this.#ensureOpen()
    const engine = query.engine ?? 'all'
    if (engine === 'codex') return this.codex.list(query)
    if (engine === 'claude-code') return this.claude.list(query)
    const limit = Math.min(200, Math.max(1, Math.floor(query.limit ?? 50)))
    const perEngine = { ...query, limit: Math.min(200, limit + Math.max(0, query.offset ?? 0)), offset: 0 }
    const [codex, claude] = await Promise.all([
      this.codex.list(perEngine),
      this.claude.list(perEngine),
    ])
    return [...codex, ...claude]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(Math.max(0, query.offset ?? 0), Math.max(0, query.offset ?? 0) + limit)
  }

  async detail(engine: CodingAgentEngine, sessionId: string, cwd?: string, limit = 500, offset?: number): Promise<CodingAgentSessionDetail> {
    this.#ensureOpen()
    return engine === 'codex' ? this.codex.detail(sessionId, limit, offset) : this.claude.detail(sessionId, cwd, limit, offset)
  }

  async config(engine: CodingAgentEngine, cwd?: string): Promise<CodingAgentConfigSnapshot> {
    this.#ensureOpen()
    return engine === 'codex' ? this.codex.config(cwd) : this.claude.config(cwd)
  }

  async writeConfig(change: CodingAgentConfigWrite): Promise<CodingAgentConfigSnapshot> {
    this.#ensureOpen()
    return change.engine === 'codex' ? this.codex.writeConfig(change) : this.claude.writeConfig(change)
  }

  async mutate(change: CodingAgentSessionMutation): Promise<{ sessionId: string }> {
    this.#ensureOpen()
    return change.engine === 'codex' ? this.codex.mutate(change) : this.claude.mutate(change)
  }

  start(request: CodingAgentRunRequest): CodingAgentRunSnapshot {
    this.#ensureOpen()
    if (request.prompt.trim() === '') throw new Error('任务内容不能为空')
    if (this.runningCount() >= this.maximumConcurrentRuns) throw new Error(`已有 ${this.maximumConcurrentRuns} 个编程助手任务正在运行，请等待或取消一个任务`)
    const id = randomUUID()
    const controller = new AbortController()
    const snapshot: CodingAgentRunSnapshot = {
      id,
      engine: request.engine,
      mode: request.mode,
      state: 'starting',
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      startedAt: Date.now(),
      output: '',
      events: [],
    }
    const active = { snapshot, controller, eventSeq: 0, promise: Promise.resolve(snapshot) } satisfies ActiveRun
    this.#runs.set(id, active)
    this.#event(active, 'status', '任务已进入运行队列')
    active.promise = this.#execute(active, request)
    active.promise.catch(() => {})
    this.#trimRuns()
    return copySnapshot(snapshot)
  }

  run(id: string, afterSeq = 0): CodingAgentRunSnapshot | undefined {
    const active = this.#runs.get(id)
    return active === undefined ? undefined : copySnapshot(active.snapshot, afterSeq)
  }

  runs(): CodingAgentRunSnapshot[] {
    return [...this.#runs.values()]
      .map(active => copySnapshot(active.snapshot))
      .sort((left, right) => right.startedAt - left.startedAt)
  }

  cancel(id: string): CodingAgentRunSnapshot {
    const active = this.#runs.get(id)
    if (active === undefined) throw new Error('任务不存在或已经被清理')
    if (active.snapshot.state === 'starting' || active.snapshot.state === 'running') {
      this.#event(active, 'status', '正在取消任务')
      active.controller.abort()
    }
    return copySnapshot(active.snapshot)
  }

  async wait(id: string, signal?: AbortSignal): Promise<CodingAgentRunSnapshot> {
    const active = this.#runs.get(id)
    if (active === undefined) throw new Error('任务不存在或已经被清理')
    if (signal === undefined) return copySnapshot(await active.promise)
    if (signal.aborted) {
      this.cancel(id)
      throw signal.reason ?? new Error('任务等待已取消')
    }
    const cancelled = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        this.cancel(id)
        reject(signal.reason ?? new Error('任务等待已取消'))
      }, { once: true })
    })
    return copySnapshot(await Promise.race([active.promise, cancelled]))
  }

  runningCount(): number {
    return [...this.#runs.values()].filter(active => active.snapshot.state === 'starting' || active.snapshot.state === 'running').length
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    for (const active of this.#runs.values()) active.controller.abort()
    await Promise.allSettled([...this.#runs.values()].map(active => active.promise))
    await Promise.allSettled([this.codex.close(), this.claude.close()])
  }

  async #execute(active: ActiveRun, request: CodingAgentRunRequest): Promise<CodingAgentRunSnapshot> {
    active.snapshot.state = 'running'
    this.#event(active, 'status', `${request.engine === 'codex' ? 'Codex' : 'Claude Code'} 已开始执行`)
    const hooks = {
      signal: active.controller.signal,
      onSession: (sessionId: string) => { active.snapshot.sessionId = sessionId },
      onTurn: (turnId: string) => { active.snapshot.turnId = turnId },
      onEvent: (type: CodingAgentRunEvent['type'], text: string, data?: unknown) => this.#event(active, type, text, data),
      onOutput: (text: string) => { active.snapshot.output = text },
    }
    try {
      const result = request.engine === 'codex'
        ? await this.codex.execute(request, hooks)
        : await this.claude.execute(request, hooks)
      active.snapshot.sessionId = result.sessionId
      if ('turnId' in result && typeof result.turnId === 'string') active.snapshot.turnId = result.turnId
      active.snapshot.output = result.output
      active.snapshot.state = active.controller.signal.aborted ? 'cancelled' : 'completed'
      this.#event(active, 'status', active.snapshot.state === 'completed' ? '任务执行完成' : '任务已取消')
    } catch (error) {
      active.snapshot.error = errorMessage(error)
      active.snapshot.state = active.controller.signal.aborted ? 'cancelled' : 'failed'
      this.#event(active, active.snapshot.state === 'cancelled' ? 'warning' : 'error', active.snapshot.error)
    } finally {
      active.snapshot.finishedAt = Date.now()
    }
    return active.snapshot
  }

  #event(active: ActiveRun, type: CodingAgentRunEvent['type'], text: string, data?: unknown): void {
    active.snapshot.events.push({
      seq: ++active.eventSeq,
      time: Date.now(),
      type,
      text,
      ...(data === undefined ? {} : { data }),
    })
    if (active.snapshot.events.length > MAX_EVENTS) active.snapshot.events.splice(0, active.snapshot.events.length - MAX_EVENTS)
  }

  #trimRuns(): void {
    if (this.#runs.size <= MAX_RETAINED_RUNS) return
    const removable = [...this.#runs.values()]
      .filter(active => active.snapshot.state !== 'starting' && active.snapshot.state !== 'running')
      .sort((left, right) => (left.snapshot.finishedAt ?? left.snapshot.startedAt) - (right.snapshot.finishedAt ?? right.snapshot.startedAt))
    while (this.#runs.size > MAX_RETAINED_RUNS) {
      const active = removable.shift()
      if (active === undefined) break
      this.#runs.delete(active.snapshot.id)
    }
  }

  #ensureOpen(): void {
    if (this.#disposed) throw new Error('编程助手服务已经关闭')
  }
}
