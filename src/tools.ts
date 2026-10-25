import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CodingAgentsManager } from './manager.ts'
import type { CodingAgentEngine, CodingAgentPermission, CodingAgentRunMode, CodingAgentSessionMutation } from './types.ts'

function engine(value: string): CodingAgentEngine {
  if (value === 'codex' || value === 'claude-code') return value
  throw new Error('engine 必须是 codex 或 claude-code')
}

function permission(value: string | undefined): CodingAgentPermission | undefined {
  if (value === undefined) return undefined
  if (value === 'read-only' || value === 'workspace-write' || value === 'full-access') return value
  throw new Error('permission 必须是 read-only、workspace-write 或 full-access')
}

function mode(value: string): CodingAgentRunMode {
  if (value === 'new' || value === 'resume' || value === 'fork') return value
  throw new Error('mode 必须是 new、resume 或 fork')
}

export function createCodingAgentTools(manager: CodingAgentsManager) {
  const status = defineTool({
    name: 'coding_agent_status',
    description: '查看 DSH 可控制的 Codex 与 Claude Code 版本、数据目录、配置文件和当前运行任务数。用户询问编程助手是否可用或安装在哪里时使用。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        installations: { type: 'string', required: true }, running: { type: 'integer', required: true }, maximumConcurrentRuns: { type: 'integer', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: (value as { installations: string }).installations }],
    },
    async execute() {
      const installations = manager.installations()
      return {
        installations: installations.map(item => `${item.label} ${item.version ?? '未知版本'}：${item.available ? '可用' : '不可用'}\n数据：${item.dataDirectory}\n配置：${item.configFile}`).join('\n\n'),
        running: manager.runningCount(),
        maximumConcurrentRuns: manager.maximumConcurrentRuns,
      }
    },
  })

  const sessions = defineTool({
    name: 'coding_agent_sessions',
    description: '快速查询或搜索本机 Codex/Claude Code 历史会话。可按引擎、关键词和工作区筛选，返回会话 ID，后续可读取、继续、分叉或管理。',
    parameters: {
      engine: { type: 'string', enum: ['all', 'codex', 'claude-code'], description: '默认 all，同时查询两个编程助手。' },
      query: { type: 'string', description: '标题、首条消息、路径或标签关键词。' },
      cwd: { type: 'string', description: '只查指定工作区；不填则查询全部。' },
      limit: { type: 'integer', description: '返回数量，默认 20，最大 100。' },
      archived: { type: 'boolean', description: 'Codex 是否查询归档会话。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        count: { type: 'integer', required: true }, sessions: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: (value as { sessions: string }).sessions }],
    },
    async execute(args: { engine?: string; query?: string; cwd?: string; limit?: number; archived?: boolean }) {
      const selected = args.engine ?? 'all'
      if (!['all', 'codex', 'claude-code'].includes(selected)) throw new Error('engine 无效')
      const found = await manager.list({
        engine: selected as 'all' | CodingAgentEngine,
        query: args.query,
        cwd: args.cwd,
        limit: Math.min(100, Math.max(1, args.limit ?? 20)),
        archived: args.archived,
      })
      return {
        count: found.length,
        sessions: found.length === 0 ? '没有找到匹配的历史会话。' : found.map(item => [
          `[${item.engine}] ${item.title}`,
          `ID: ${item.id}`,
          item.cwd === undefined ? undefined : `工作区: ${item.cwd}`,
          item.preview === '' ? undefined : `摘要: ${item.preview.slice(0, 300)}`,
          `更新: ${new Date(item.updatedAt).toLocaleString('zh-CN')}`,
        ].filter(Boolean).join('\n')).join('\n\n'),
      }
    },
  })

  const history = defineTool({
    name: 'coding_agent_history',
    description: '分页读取一个 Codex 或 Claude Code 历史会话的消息。默认返回最近 200 条；可用 offset 从最早消息起分段读取超长会话。先用 coding_agent_sessions 找到准确的会话 ID。',
    parameters: {
      engine: { type: 'string', enum: ['codex', 'claude-code'], required: true },
      sessionId: { type: 'string', required: true },
      cwd: { type: 'string', description: 'Claude Code 会话的工作区；不知道时可以不填，由 SDK 全局查找。' },
      limit: { type: 'integer', description: '每页数量，默认 200，最大 1000。' },
      offset: { type: 'integer', description: '从最早一条起的偏移；不填时返回最近一页。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        title: { type: 'string', required: true }, sessionId: { type: 'string', required: true }, messageCount: { type: 'integer', required: true }, totalMessageCount: { type: 'integer', required: true }, messageOffset: { type: 'integer', required: true }, hasMoreBefore: { type: 'boolean', required: true }, hasMoreAfter: { type: 'boolean', required: true }, history: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: (value as { history: string }).history }],
    },
    async execute(args: { engine: string; sessionId: string; cwd?: string; limit?: number; offset?: number }) {
      const detail = await manager.detail(engine(args.engine), args.sessionId, args.cwd, Math.min(1_000, Math.max(1, args.limit ?? 200)), args.offset)
      return {
        title: detail.title,
        sessionId: detail.id,
        messageCount: detail.messages.length,
        totalMessageCount: detail.totalMessageCount,
        messageOffset: detail.messageOffset,
        hasMoreBefore: detail.hasMoreBefore,
        hasMoreAfter: detail.hasMoreAfter,
        history: detail.messages.map(message => `${message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : message.role === 'tool' ? '工具' : '系统'}：${message.text}`).join('\n\n'),
      }
    },
  })

  const run = defineTool({
    name: 'coding_agent_run',
    description: '直接让 Codex 或 Claude Code 执行编程任务，可新建、继续或分叉现有会话。默认等待任务完成并返回最终输出；会保留原工具的文件编辑、命令执行和多步 Agent 能力。',
    parameters: {
      engine: { type: 'string', enum: ['codex', 'claude-code'], required: true },
      mode: { type: 'string', enum: ['new', 'resume', 'fork'], required: true },
      prompt: { type: 'string', required: true, description: '交给编程助手的完整任务。' },
      cwd: { type: 'string', description: '任务工作区；新会话建议明确提供。' },
      sessionId: { type: 'string', description: 'resume/fork 必填。' },
      model: { type: 'string' },
      effort: { type: 'string', description: '模型支持的思考强度，例如 low/medium/high/xhigh/max。' },
      permission: { type: 'string', enum: ['read-only', 'workspace-write', 'full-access'], description: '默认 workspace-write；full-access 仅在用户明确要求时使用。' },
      wait: { type: 'boolean', description: '默认 true。false 时只启动并返回 runId。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        runId: { type: 'string', required: true }, state: { type: 'string', required: true }, sessionId: { type: 'string' }, output: { type: 'string', required: true }, error: { type: 'string' },
      } },
      render: (_args, value) => {
        const result = value as { state: string; output: string; error?: string; runId: string }
        return [{ type: 'text', text: result.error ?? (result.output || `任务 ${result.runId} 状态：${result.state}`) }]
      },
    },
    async execute(args: { engine: string; mode: string; prompt: string; cwd?: string; sessionId?: string; model?: string; effort?: string; permission?: string; wait?: boolean }, exec) {
      const started = manager.start({
        engine: engine(args.engine),
        mode: mode(args.mode),
        prompt: args.prompt,
        cwd: args.cwd,
        sessionId: args.sessionId,
        model: args.model,
        effort: args.effort,
        permission: permission(args.permission),
      })
      const result = args.wait === false ? started : await manager.wait(started.id, exec.signal)
      return {
        runId: result.id,
        state: result.state,
        ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
        output: result.output,
        ...(result.error === undefined ? {} : { error: result.error }),
      }
    },
  })

  const manage = defineTool({
    name: 'coding_agent_session_manage',
    description: '管理 Codex/Claude Code 会话：重命名、标签、归档、取消归档、分叉、回滚或删除。不同引擎不支持的操作会明确拒绝，不会静默改动。删除前应得到用户明确授权。',
    parameters: {
      engine: { type: 'string', enum: ['codex', 'claude-code'], required: true },
      sessionId: { type: 'string', required: true },
      action: { type: 'string', enum: ['rename', 'tag', 'archive', 'unarchive', 'fork', 'rollback', 'delete'], required: true },
      cwd: { type: 'string' }, title: { type: 'string' }, tag: { type: 'string' }, upToMessageId: { type: 'string' }, turns: { type: 'integer' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { sessionId: { type: 'string', required: true }, message: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: (value as { message: string }).message }],
    },
    async execute(args: { engine: string; sessionId: string; action: CodingAgentSessionMutation['action']; cwd?: string; title?: string; tag?: string; upToMessageId?: string; turns?: number }) {
      const result = await manager.mutate({ ...args, engine: engine(args.engine) })
      return { sessionId: result.sessionId, message: `${args.action} 操作已完成，会话 ID：${result.sessionId}` }
    },
  })

  const config = defineTool({
    name: 'coding_agent_config',
    description: '读取或修改 Codex/Claude Code 配置。写入 Claude Code 配置前会自动备份并原子替换；Codex 通过官方配置协议写入。读取时可检查有效配置和来源。',
    parameters: {
      action: { type: 'string', enum: ['read', 'write', 'remove'], required: true },
      engine: { type: 'string', enum: ['codex', 'claude-code'], required: true },
      cwd: { type: 'string' },
      target: { type: 'string', enum: ['user', 'project', 'local'], description: 'Claude 可选 user/project/local；Codex 只支持 user。' },
      keyPath: { type: 'string', description: 'write/remove 必填，例如 permissions.defaultMode。' },
      valueJson: { type: 'string', description: 'write 必填，必须是合法 JSON，例如 "high"、true 或 {"allow":[]}。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { engine: { type: 'string', required: true }, configJson: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: (value as { configJson: string }).configJson }],
    },
    async execute(args: { action: 'read' | 'write' | 'remove'; engine: string; cwd?: string; target?: string; keyPath?: string; valueJson?: string }) {
      const selected = engine(args.engine)
      let snapshot
      if (args.action === 'read') snapshot = await manager.config(selected, args.cwd)
      else {
        if (args.keyPath?.trim() === '') throw new Error('write/remove 需要 keyPath')
        let value: unknown
        if (args.action === 'write') {
          if (args.valueJson === undefined) throw new Error('write 需要 valueJson')
          try { value = JSON.parse(args.valueJson) } catch { throw new Error('valueJson 不是合法 JSON') }
        }
        snapshot = await manager.writeConfig({
          engine: selected,
          keyPath: args.keyPath!,
          value,
          cwd: args.cwd,
          target: args.target,
          remove: args.action === 'remove',
        })
      }
      return { engine: selected, configJson: JSON.stringify(snapshot, null, 2) }
    },
  })

  return [status, sessions, history, run, manage, config] as const
}
