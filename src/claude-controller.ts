import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query as claudeQuery,
  renameSession,
  resolveSettings,
  tagSession,
  type Options as ClaudeOptions,
  type Query as ClaudeQuery,
  type SDKMessage,
  type SDKSessionInfo,
  type SessionMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import { scrubbedParentEnv, type SubprocessHandle, type SubprocessOutcome, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
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
const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk')
const sdkManifest = JSON.parse(readFileSync(join(dirname(sdkEntry), 'package.json'), 'utf8')) as {
  version: string
  claudeCodeVersion?: string
}
const CLAUDE_EXECUTABLE = resolveNativePackageExecutable(
  `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'claude.exe' : 'claude',
)

type SubprocessFace = Pick<SubprocessRuntime, 'spawn'>

export interface ClaudeHooks {
  signal: AbortSignal
  onSession(sessionId: string): void
  onEvent(type: 'status' | 'text' | 'tool' | 'warning' | 'error', text: string, data?: unknown): void
  onOutput(text: string): void
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function textOf(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.map(item => textOf(item, depth + 1)).filter(Boolean).join('\n')
  }
  const item = record(value)
  if (item === undefined) return ''
  if (item.type === 'tool_use') {
    const name = nonEmpty(item.name) ?? '工具'
    return `${name}\n${JSON.stringify(item.input ?? {}, null, 2)}`
  }
  if (item.type === 'tool_result') return textOf(item.content, depth + 1)
  for (const key of ['text', 'content', 'message', 'result', 'summary']) {
    const text = textOf(item[key], depth + 1)
    if (text !== '') return text
  }
  return ''
}

function summaryOf(session: SDKSessionInfo): CodingAgentSessionSummary {
  return {
    engine: 'claude-code',
    id: session.sessionId,
    title: session.customTitle ?? (session.summary || '未命名 Claude Code 会话'),
    preview: session.firstPrompt ?? session.summary ?? '',
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
    updatedAt: session.lastModified,
    ...(session.gitBranch === undefined ? {} : { branch: session.gitBranch }),
    ...(session.tag === undefined ? {} : { tag: session.tag }),
  }
}

function historicalMessage(message: SessionMessage, index: number): CodingAgentMessage {
  const body = record(message.message)
  const kind = nonEmpty(body?.type) ?? message.type
  return {
    id: message.uuid || `claude-message-${index}`,
    role: message.type,
    text: textOf(body?.content ?? body ?? message.message) || `[${kind}]`,
    kind,
    raw: message,
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate))
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function candidatePath(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'notebook_path', 'directory']) {
    const value = nonEmpty(input[key])
    if (value !== undefined) return value
  }
  return undefined
}

function workspacePermission(cwd: string) {
  return async (toolName: string, input: Record<string, unknown>) => {
    if (toolName === 'AskUserQuestion') {
      return { behavior: 'deny' as const, message: '当前任务由 DSH 后台运行，不能显示 Claude Code 的二次问答。请直接向用户说明需要补充的信息。' }
    }
    if (['Write', 'Edit', 'NotebookEdit', 'MultiEdit'].includes(toolName)) {
      const path = candidatePath(input)
      if (path !== undefined) {
        const absolute = isAbsolute(path) ? path : resolve(cwd, path)
        if (!isInside(cwd, absolute)) {
          return { behavior: 'deny' as const, message: `工作区写入模式不允许修改工作区之外的路径：${path}` }
        }
      }
    }
    return { behavior: 'allow' as const, updatedInput: input }
  }
}

function sdkEnvironmentOverlay(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const overlay: NodeJS.ProcessEnv = { ...env }
  for (const name of Object.keys(scrubbedParentEnv())) {
    if (!(name in env)) overlay[name] = undefined
  }
  return overlay
}

class ManagedClaudeProcess implements SpawnedProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly #events = new EventEmitter()
  #outcome?: SubprocessOutcome
  #killRequested = false

  constructor(readonly child: SubprocessHandle) {
    if (child.stdin === undefined || child.stdout === undefined) throw new Error('Claude Code 没有提供协议管道')
    this.stdin = child.stdin
    this.stdout = child.stdout
    this.#events.on('error', () => {})
    child.done.then((outcome) => {
      this.#outcome = outcome
      this.#events.emit('exit', outcome.exitCode, outcome.signal)
    }, (error: unknown) => this.#events.emit('error', error instanceof Error ? error : new Error(String(error))))
  }

  get killed(): boolean { return this.#killRequested }
  get exitCode(): number | null { return this.#outcome?.exitCode ?? null }
  get signalCode(): NodeJS.Signals | null { return this.#outcome?.signal ?? null }

  kill(_signal: NodeJS.Signals): boolean {
    if (this.#killRequested || this.#outcome !== undefined) return false
    this.#killRequested = true
    this.child.terminate()
    return true
  }

  on(event: 'exit' | 'error', listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): void {
    this.#events.on(event, listener)
  }

  once(event: 'exit' | 'error', listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): void {
    this.#events.once(event, listener)
  }

  off(event: 'exit' | 'error', listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): void {
    this.#events.off(event, listener)
  }
}

function toolResultText(block: Record<string, unknown>): string {
  const content = textOf(block.content)
  return content === '' ? JSON.stringify(block) : content
}

function emitClaudeMessage(hooks: ClaudeHooks, message: SDKMessage, toolNames: Map<string, string>): void {
  if ('session_id' in message && typeof message.session_id === 'string' && message.session_id !== '') hooks.onSession(message.session_id)
  if (message.type === 'assistant') {
    for (const raw of message.message.content) {
      const block = record(raw)
      if (block?.type === 'tool_use') {
        const id = nonEmpty(block.id) ?? 'claude-tool'
        const name = nonEmpty(block.name) ?? 'Claude Code 工具'
        toolNames.set(id, name)
        hooks.onEvent('tool', `开始：${name}`, { id, input: block.input })
      } else if (block?.type === 'thinking') {
        const thinking = nonEmpty(block.thinking)
        if (thinking !== undefined) hooks.onEvent('text', thinking, { kind: 'thinking' })
      } else if (block?.type === 'text') {
        const text = nonEmpty(block.text)
        if (text !== undefined) hooks.onEvent('text', text, { kind: 'assistant' })
      }
    }
    return
  }
  if (message.type === 'user' && Array.isArray(message.message.content)) {
    for (const raw of message.message.content) {
      const block = record(raw)
      if (block?.type !== 'tool_result') continue
      const id = nonEmpty(block.tool_use_id) ?? 'claude-tool'
      hooks.onEvent('tool', `完成：${toolNames.get(id) ?? 'Claude Code 工具'}`, {
        id,
        output: message.tool_use_result ?? toolResultText(block),
        isError: block.is_error === true,
      })
      toolNames.delete(id)
    }
    return
  }
  if (message.type === 'tool_progress') {
    hooks.onEvent('tool', `${message.tool_name} 已运行 ${message.elapsed_time_seconds.toFixed(1)} 秒`, message)
    return
  }
  if (message.type === 'tool_use_summary') {
    hooks.onEvent('status', message.summary, message)
    return
  }
  if (message.type === 'system') {
    if (message.subtype === 'init') hooks.onEvent('status', `Claude Code ${message.claude_code_version} 已就绪`, message)
    else if (message.subtype === 'permission_denied') hooks.onEvent('warning', message.message, message)
    else if (message.subtype === 'informational') hooks.onEvent(message.level === 'warning' ? 'warning' : 'status', message.content, message)
    else if (message.subtype === 'api_retry') hooks.onEvent('warning', `模型请求正在重试（${message.attempt}/${message.max_retries}）`, message)
  }
}

function permissionOptions(permission: CodingAgentPermission, cwd: string): Pick<ClaudeOptions, 'permissionMode' | 'allowDangerouslySkipPermissions' | 'canUseTool'> {
  if (permission === 'full-access') return { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
  if (permission === 'read-only') return { permissionMode: 'plan' }
  return { permissionMode: 'acceptEdits', canUseTool: workspacePermission(cwd) }
}

function configRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
}

function targetPath(target: string | undefined, cwd: string | undefined): string {
  if (target === undefined || target === 'user') return join(configRoot(), 'settings.json')
  if (cwd === undefined || cwd.trim() === '') throw new Error('修改项目配置需要指定工作区目录')
  if (target === 'project') return join(resolve(cwd), '.claude', 'settings.json')
  if (target === 'local') return join(resolve(cwd), '.claude', 'settings.local.json')
  throw new Error(`未知的 Claude Code 配置目标：${target}`)
}

function pathSegments(keyPath: string): string[] {
  const parts = keyPath.split('.').map(part => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('配置键不能为空')
  if (parts.some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('配置键包含不安全路径')
  return parts
}

function setAt(root: Record<string, unknown>, parts: string[], value: unknown, remove: boolean): void {
  let cursor = root
  for (const part of parts.slice(0, -1)) {
    const child = record(cursor[part])
    cursor[part] = child ?? {}
    cursor = cursor[part] as Record<string, unknown>
  }
  const leaf = parts.at(-1)!
  if (remove) delete cursor[leaf]
  else cursor[leaf] = value
}

async function readConfigObject(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {}
  const raw = await readFile(path, 'utf8')
  if (Buffer.byteLength(raw, 'utf8') > 4 * 1024 * 1024) throw new Error(`配置文件超过 4 MiB，拒绝自动修改：${path}`)
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (error) { throw new Error(`配置文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`) }
  const object = record(parsed)
  if (object === undefined) throw new Error('Claude Code 配置文件必须是 JSON 对象')
  return object
}

async function atomicWriteConfig(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const temporary = `${path}.dsh-${suffix}.tmp`
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    await copyFile(path, `${path}.backup-dsh-${stamp}`)
  }
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export class ClaudeController {
  readonly sdkVersion = sdkManifest.version
  readonly version = sdkManifest.claudeCodeVersion ?? sdkManifest.version
  readonly executable = CLAUDE_EXECUTABLE
  readonly dataDirectory = configRoot()
  readonly configFile = join(this.dataDirectory, 'settings.json')
  readonly #queries = new Set<ClaudeQuery>()
  #closed = false

  constructor(private readonly subprocess: SubprocessFace) {}

  async list(filter: CodingAgentSessionQuery): Promise<CodingAgentSessionSummary[]> {
    const limit = Math.min(200, Math.max(1, Math.floor(filter.limit ?? 50)))
    const sessions = await listSessions({
      ...(filter.cwd?.trim() ? { dir: filter.cwd.trim() } : {}),
      limit: Math.min(1_000, limit + Math.max(0, filter.offset ?? 0)),
      includeProgrammatic: true,
    })
    const query = filter.query?.trim().toLocaleLowerCase()
    return sessions
      .map(summaryOf)
      .filter(session => query === undefined || `${session.title}\n${session.preview}\n${session.cwd ?? ''}\n${session.tag ?? ''}`.toLocaleLowerCase().includes(query))
      .slice(Math.max(0, filter.offset ?? 0), Math.max(0, filter.offset ?? 0) + limit)
  }

  async detail(sessionId: string, cwd?: string, limit = 500, offset?: number): Promise<CodingAgentSessionDetail> {
    const options = cwd === undefined || cwd.trim() === '' ? {} : { dir: cwd }
    const [session, all] = await Promise.all([
      getSessionInfo(sessionId, options),
      getSessionMessages(sessionId, { ...options, includeSystemMessages: true }),
    ])
    if (session === undefined) throw new Error('Claude Code 会话不存在或无法读取')
    const pageSize = Math.min(2_000, Math.max(1, Math.floor(limit)))
    const start = Math.min(all.length, Math.max(0, offset === undefined ? all.length - pageSize : Math.floor(offset)))
    return {
      ...summaryOf(session),
      messages: all.slice(start, start + pageSize).map((message, index) => historicalMessage(message, start + index)),
      totalMessageCount: all.length,
      messageOffset: start,
      hasMoreBefore: start > 0,
      hasMoreAfter: start + pageSize < all.length,
      raw: session,
    }
  }

  async config(cwd?: string): Promise<CodingAgentConfigSnapshot> {
    const resolved = await resolveSettings({ ...(cwd === undefined || cwd.trim() === '' ? {} : { cwd }) })
    const root = cwd === undefined || cwd.trim() === '' ? undefined : resolve(cwd)
    return {
      engine: 'claude-code',
      ...(cwd === undefined ? {} : { cwd }),
      effective: resolved.effective as Record<string, unknown>,
      sources: resolved.sources.map(source => ({
        kind: source.source,
        ...(source.path === undefined ? {} : { path: source.path }),
        value: source.settings as Record<string, unknown>,
      })),
      editableTargets: [
        { id: 'user', label: '用户配置', path: this.configFile },
        ...(root === undefined ? [] : [
          { id: 'project', label: '项目共享配置', path: join(root, '.claude', 'settings.json') },
          { id: 'local', label: '项目本机配置', path: join(root, '.claude', 'settings.local.json') },
        ]),
      ],
    }
  }

  async writeConfig(change: CodingAgentConfigWrite): Promise<CodingAgentConfigSnapshot> {
    const path = targetPath(change.target, change.cwd)
    const value = await readConfigObject(path)
    setAt(value, pathSegments(change.keyPath), change.value, change.remove === true)
    await atomicWriteConfig(path, value)
    return this.config(change.cwd)
  }

  async mutate(change: CodingAgentSessionMutation): Promise<{ sessionId: string }> {
    const options = change.cwd === undefined || change.cwd.trim() === '' ? {} : { dir: change.cwd }
    if (change.action === 'rename') {
      if (change.title?.trim() === '') throw new Error('会话名称不能为空')
      await renameSession(change.sessionId, change.title!.trim(), options)
      return { sessionId: change.sessionId }
    }
    if (change.action === 'tag') {
      await tagSession(change.sessionId, change.tag?.trim() || null, options)
      return { sessionId: change.sessionId }
    }
    if (change.action === 'delete') {
      await deleteSession(change.sessionId, options)
      return { sessionId: change.sessionId }
    }
    if (change.action === 'fork') {
      const result = await forkSession(change.sessionId, {
        ...options,
        ...(change.upToMessageId === undefined ? {} : { upToMessageId: change.upToMessageId }),
        ...(change.title === undefined ? {} : { title: change.title }),
      })
      return result
    }
    throw new Error(`Claude Code 不支持会话操作 ${change.action}`)
  }

  async execute(request: CodingAgentRunRequest, hooks: ClaudeHooks): Promise<{ sessionId: string; output: string }> {
    if (this.#closed) throw new Error('Claude Code 控制器已经关闭')
    if (request.mode !== 'new' && request.sessionId === undefined) throw new Error('继续或分叉 Claude Code 会话需要 sessionId')
    const cwd = resolve(request.cwd?.trim() || process.cwd())
    const abortController = new AbortController()
    const abort = (): void => abortController.abort()
    if (hooks.signal.aborted) abort()
    else hooks.signal.addEventListener('abort', abort, { once: true })
    let child: SubprocessHandle | undefined
    let run: ClaudeQuery | undefined
    const toolNames = new Map<string, string>()
    try {
      const options: ClaudeOptions = {
        abortController,
        cwd,
        env: scrubbedParentEnv(),
        persistSession: true,
        settingSources: ['user', 'project', 'local'],
        tools: { type: 'preset', preset: 'claude_code' },
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
        includePartialMessages: false,
        ...permissionOptions(request.permission ?? 'workspace-write', cwd),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.effort === undefined ? {} : { effort: request.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' }),
        ...(request.mode === 'new' ? {} : { resume: request.sessionId, forkSession: request.mode === 'fork' }),
        stderr: data => hooks.onEvent('warning', data),
        spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) => {
          if (spawnOptions.cwd === undefined || spawnOptions.cwd === '') throw new Error('Claude Code 没有指定工作区')
          child = this.subprocess.spawn({
            argv: [spawnOptions.command, ...spawnOptions.args],
            cwd: spawnOptions.cwd,
            env: sdkEnvironmentOverlay(spawnOptions.env),
            stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
            graceMs: 3_000,
            signal: spawnOptions.signal,
          })
          return new ManagedClaudeProcess(child)
        },
      }
      run = claudeQuery({ prompt: request.prompt, options })
      this.#queries.add(run)
      hooks.onEvent('status', request.mode === 'new' ? 'Claude Code 新会话正在启动' : request.mode === 'fork' ? 'Claude Code 分叉会话正在启动' : 'Claude Code 会话正在继续')
      let output = ''
      let sessionId = request.sessionId ?? ''
      for await (const message of run) {
        if ('session_id' in message && typeof message.session_id === 'string' && message.session_id !== '') sessionId = message.session_id
        emitClaudeMessage(hooks, message, toolNames)
        if (message.type !== 'result') continue
        if (message.subtype === 'success' && !message.is_error) {
          output = message.result
          hooks.onOutput(output)
        } else {
          const diagnostic = message.subtype === 'success' ? message.result : message.errors.join('; ')
          throw new Error(diagnostic || `Claude Code 本轮状态：${message.subtype}`)
        }
      }
      if (sessionId === '') throw new Error('Claude Code 未返回会话 ID')
      return { sessionId, output }
    } finally {
      hooks.signal.removeEventListener('abort', abort)
      if (run !== undefined) {
        this.#queries.delete(run)
        run.close()
      }
      if (child !== undefined && hooks.signal.aborted) child.terminate()
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const run of this.#queries) run.close()
    this.#queries.clear()
  }
}
