import type {
  CodingAgentConfigSnapshot,
  CodingAgentConfigWrite,
  CodingAgentEngine,
  CodingAgentInstallation,
  CodingAgentRunRequest,
  CodingAgentRunSnapshot,
  CodingAgentSessionDetail,
  CodingAgentSessionMutation,
  CodingAgentSessionQuery,
  CodingAgentSessionSummary,
} from '../src/types.ts'

const PREFIX = '/coding-agents-api'

interface ApiResponse {
  ok: boolean
  code?: string
  hint?: string
}

async function request<T extends ApiResponse>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${PREFIX}${path}`, {
    ...init,
    headers: init?.body === undefined ? init?.headers : { 'content-type': 'application/json', ...init.headers },
  })
  const value = await response.json() as T
  if (!response.ok || !value.ok) throw new Error(value.hint ?? `编程助手接口失败（${response.status}）`)
  return value
}

function queryString(input: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== '') params.set(key, String(value))
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

export interface CodingAgentsApi {
  status(): Promise<{ installations: CodingAgentInstallation[]; running: number; maximumConcurrentRuns: number }>
  sessions(query: CodingAgentSessionQuery): Promise<CodingAgentSessionSummary[]>
  detail(engine: CodingAgentEngine, sessionId: string, cwd?: string, limit?: number, offset?: number): Promise<CodingAgentSessionDetail>
  mutate(change: CodingAgentSessionMutation): Promise<{ sessionId: string }>
  config(engine: CodingAgentEngine, cwd?: string): Promise<CodingAgentConfigSnapshot>
  writeConfig(change: CodingAgentConfigWrite): Promise<CodingAgentConfigSnapshot>
  runs(): Promise<CodingAgentRunSnapshot[]>
  run(id: string, after?: number): Promise<CodingAgentRunSnapshot>
  start(input: CodingAgentRunRequest): Promise<CodingAgentRunSnapshot>
  cancel(id: string): Promise<CodingAgentRunSnapshot>
}

export function createCodingAgentsApi(): CodingAgentsApi {
  return {
    async status() {
      const result = await request<ApiResponse & { installations: CodingAgentInstallation[]; running: number; maximumConcurrentRuns: number }>('/status')
      return result
    },
    async sessions(query) {
      const result = await request<ApiResponse & { sessions: CodingAgentSessionSummary[] }>(`/sessions${queryString({
        engine: query.engine,
        query: query.query,
        cwd: query.cwd,
        limit: query.limit,
        offset: query.offset,
        archived: query.archived,
      })}`)
      return result.sessions
    },
    async detail(engine, sessionId, cwd, limit, offset) {
      const result = await request<ApiResponse & { session: CodingAgentSessionDetail }>(`/sessions/${engine}/${encodeURIComponent(sessionId)}${queryString({ cwd, limit, offset })}`)
      return result.session
    },
    async mutate(change) {
      const result = await request<ApiResponse & { result: { sessionId: string } }>('/sessions/mutate', { method: 'POST', body: JSON.stringify(change) })
      return result.result
    },
    async config(engine, cwd) {
      const result = await request<ApiResponse & { config: CodingAgentConfigSnapshot }>(`/config/${engine}${queryString({ cwd })}`)
      return result.config
    },
    async writeConfig(change) {
      const result = await request<ApiResponse & { config: CodingAgentConfigSnapshot }>('/config', { method: 'POST', body: JSON.stringify(change) })
      return result.config
    },
    async runs() {
      const result = await request<ApiResponse & { runs: CodingAgentRunSnapshot[] }>('/runs')
      return result.runs
    },
    async run(id, after) {
      const result = await request<ApiResponse & { run: CodingAgentRunSnapshot }>(`/runs/${encodeURIComponent(id)}${queryString({ after })}`)
      return result.run
    },
    async start(input) {
      const result = await request<ApiResponse & { run: CodingAgentRunSnapshot }>('/runs', { method: 'POST', body: JSON.stringify(input) })
      return result.run
    },
    async cancel(id) {
      const result = await request<ApiResponse & { run: CodingAgentRunSnapshot }>(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' })
      return result.run
    },
  }
}
