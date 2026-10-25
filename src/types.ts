export type CodingAgentEngine = 'codex' | 'claude-code'
export type CodingAgentPermission = 'read-only' | 'workspace-write' | 'full-access'
export type CodingAgentRunMode = 'new' | 'resume' | 'fork'

export interface CodingAgentInstallation {
  engine: CodingAgentEngine
  label: string
  available: boolean
  version?: string
  executable?: string
  dataDirectory: string
  configFile: string
  diagnostic?: string
}

export interface CodingAgentSessionSummary {
  engine: CodingAgentEngine
  id: string
  title: string
  preview: string
  cwd?: string
  createdAt?: number
  updatedAt: number
  model?: string
  branch?: string
  tag?: string
  archived?: boolean
  status?: string
  source?: string
  parentId?: string
}

export interface CodingAgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  text: string
  createdAt?: number
  kind?: string
  raw?: unknown
}

export interface CodingAgentSessionDetail extends CodingAgentSessionSummary {
  messages: CodingAgentMessage[]
  totalMessageCount: number
  messageOffset: number
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  raw?: unknown
}

export interface CodingAgentSessionQuery {
  engine?: CodingAgentEngine | 'all'
  query?: string
  cwd?: string
  limit?: number
  offset?: number
  archived?: boolean
}

export interface CodingAgentRunRequest {
  engine: CodingAgentEngine
  mode: CodingAgentRunMode
  prompt: string
  cwd?: string
  sessionId?: string
  model?: string
  effort?: string
  permission?: CodingAgentPermission
}

export type CodingAgentRunState = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface CodingAgentRunEvent {
  seq: number
  time: number
  type: 'status' | 'text' | 'tool' | 'warning' | 'error'
  text: string
  data?: unknown
}

export interface CodingAgentRunSnapshot {
  id: string
  engine: CodingAgentEngine
  mode: CodingAgentRunMode
  state: CodingAgentRunState
  sessionId?: string
  turnId?: string
  cwd?: string
  startedAt: number
  finishedAt?: number
  output: string
  error?: string
  events: CodingAgentRunEvent[]
}

export interface CodingAgentConfigSnapshot {
  engine: CodingAgentEngine
  cwd?: string
  effective: Record<string, unknown>
  sources: Array<{ kind: string; path?: string; version?: string; value?: Record<string, unknown> }>
  editableTargets: Array<{ id: string; label: string; path: string }>
}

export interface CodingAgentConfigWrite {
  engine: CodingAgentEngine
  keyPath: string
  value: unknown
  cwd?: string
  target?: string
  remove?: boolean
}

export interface CodingAgentSessionMutation {
  engine: CodingAgentEngine
  sessionId: string
  cwd?: string
  action: 'rename' | 'tag' | 'archive' | 'unarchive' | 'fork' | 'rollback' | 'delete'
  title?: string
  tag?: string | null
  upToMessageId?: string
  turns?: number
}
