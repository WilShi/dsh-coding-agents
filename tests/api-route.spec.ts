import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCodingAgentsRoute, type CodingAgentsRouteOptions } from '../src/api-route.ts'
import type { CodingAgentsManager } from '../src/manager.ts'

const servers: Array<ReturnType<typeof createServer>> = []
const WORKSPACE = '/tmp/coding-agents-workspace'

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

interface Served {
  base: string
  origin: string
}

async function serve(manager: Partial<CodingAgentsManager>, options: CodingAgentsRouteOptions = {}): Promise<Served> {
  const server = createServer(createCodingAgentsRoute(manager as CodingAgentsManager, options))
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing address')
  const origin = `http://127.0.0.1:${address.port}`
  return { base: `${origin}/coding-agents-api`, origin }
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function runManager(): Partial<CodingAgentsManager> {
  return {
    start: vi.fn(() => ({
      id: 'run-1',
      engine: 'codex',
      mode: 'new',
      state: 'starting',
      startedAt: 1,
      output: '',
      events: [],
    })),
  } as unknown as Partial<CodingAgentsManager>
}

describe('coding agents HTTP API', () => {
  it('returns status and combined sessions', async () => {
    const manager = {
      installations: vi.fn(() => [{ engine: 'codex', available: true }]),
      runningCount: vi.fn(() => 0),
      maximumConcurrentRuns: 4,
      list: vi.fn(async () => [{ engine: 'codex', id: '1', title: 'one', preview: '', updatedAt: 1 }]),
    }
    const { base, origin } = await serve(manager)
    const status = await fetch(`${base}/status`, { headers: { origin } }).then(response => response.json())
    expect(status).toMatchObject({ ok: true, running: 0, maximumConcurrentRuns: 4 })
    const sessions = await fetch(`${base}/sessions?engine=all&limit=10`, { headers: { origin } }).then(response => response.json())
    expect(sessions).toMatchObject({ ok: true, sessions: [{ id: '1' }] })
  })

  it('validates run requests before starting them', async () => {
    const manager = { start: vi.fn() }
    const { base, origin } = await serve(manager)
    const result = await postJson(`${base}/runs`, { engine: 'unknown', mode: 'new', prompt: 'x' }, { origin }).then(response => response.json())
    expect(result).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(manager.start).not.toHaveBeenCalled()
  })

  it('accepts a same-origin browser request and rejects a cross-origin one', async () => {
    const manager = runManager()
    const { base, origin } = await serve(manager, { workspaceRoots: () => [WORKSPACE] })

    const allowed = await postJson(`${base}/runs`, { engine: 'codex', mode: 'new', prompt: 'ok' }, { origin })
    expect(allowed.status).toBe(200)
    expect(manager.start).toHaveBeenCalledTimes(1)

    const denied = await postJson(`${base}/runs`, { engine: 'codex', mode: 'new', prompt: 'evil' }, { origin: 'http://evil.example' })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ ok: false, code: 'CROSS_ORIGIN_REJECTED' })
    expect(manager.start).toHaveBeenCalledTimes(1)
  })

  it('rejects a browser whose Sec-Fetch-Site marks the request cross-site', async () => {
    const manager = runManager()
    const { base } = await serve(manager, { workspaceRoots: () => [WORKSPACE] })
    const response = await postJson(`${base}/runs`, { engine: 'codex', mode: 'new', prompt: 'evil' }, { 'sec-fetch-site': 'cross-site' })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'CROSS_ORIGIN_REJECTED' })
    expect(manager.start).not.toHaveBeenCalled()
  })

  it('guards reads as well as mutations', async () => {
    const manager = { list: vi.fn(async () => []), installations: vi.fn(() => []), runningCount: vi.fn(() => 0), maximumConcurrentRuns: 4 }
    const { base } = await serve(manager)
    const response = await fetch(`${base}/status`, { headers: { origin: 'http://evil.example' } })
    expect(response.status).toBe(403)
    expect(manager.installations).not.toHaveBeenCalled()
  })

  it('requires JSON content type for POST bodies', async () => {
    const manager = runManager()
    const { base, origin } = await serve(manager, { workspaceRoots: () => [WORKSPACE] })
    const response = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { origin, 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ engine: 'codex', mode: 'new', prompt: 'ok' }),
    })
    expect(response.status).toBe(415)
    expect(await response.json()).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA_TYPE' })
    expect(manager.start).not.toHaveBeenCalled()
  })

  it('answers CORS preflight with 405 instead of a route', async () => {
    const manager = runManager()
    const { base, origin } = await serve(manager)
    const response = await fetch(`${base}/runs`, { method: 'OPTIONS', headers: { origin } })
    expect(response.status).toBe(405)
    expect(await response.json()).toMatchObject({ ok: false, code: 'METHOD_NOT_ALLOWED' })
  })

  it('refuses full-access over HTTP and explains the safe path', async () => {
    const manager = runManager()
    const { base, origin } = await serve(manager, { workspaceRoots: () => [WORKSPACE] })
    const response = await postJson(`${base}/runs`, { engine: 'claude-code', mode: 'new', prompt: 'x', permission: 'full-access' }, { origin })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toMatchObject({ ok: false, code: 'PERMISSION_FULL_ACCESS_BLOCKED' })
    expect(body.hint).toContain('DSH 界面')
    expect(manager.start).not.toHaveBeenCalled()
  })

  it('bounds cwd to registered workspaces', async () => {
    const manager = runManager()
    const { base, origin } = await serve(manager, { workspaceRoots: () => [WORKSPACE] })

    const escaped = await postJson(`${base}/runs`, { engine: 'codex', mode: 'new', prompt: 'x', cwd: '/etc' }, { origin })
    expect(escaped.status).toBe(400)
    expect(await escaped.json()).toMatchObject({ ok: false, code: 'WORKSPACE_OUT_OF_SCOPE' })
    expect(manager.start).not.toHaveBeenCalled()

    const nested = await postJson(`${base}/runs`, { engine: 'codex', mode: 'new', prompt: 'x', cwd: `${WORKSPACE}/project` }, { origin })
    expect(nested.status).toBe(200)
    expect(manager.start).toHaveBeenCalledWith(expect.objectContaining({ cwd: `${WORKSPACE}/project` }))

    const sibling = await postJson(`${base}/runs`, { engine: 'codex', mode: 'new', prompt: 'x', cwd: `${WORKSPACE}-other` }, { origin })
    expect(sibling.status).toBe(400)
    expect(await sibling.json()).toMatchObject({ code: 'WORKSPACE_OUT_OF_SCOPE' })
  })

  it('refuses cwd when the host exposes no workspace registry', async () => {
    const manager = runManager()
    const { base, origin } = await serve(manager)
    const response = await postJson(`${base}/runs`, { engine: 'codex', mode: 'new', prompt: 'x', cwd: WORKSPACE }, { origin })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, code: 'WORKSPACE_UNVERIFIABLE' })
    expect(manager.start).not.toHaveBeenCalled()
  })

  it('restricts configuration writes to the allowlisted key paths', async () => {
    const manager = { writeConfig: vi.fn(async () => ({ engine: 'codex', effective: {}, sources: [], editableTargets: [] })) }
    const { base, origin } = await serve(manager)

    const blocked = await postJson(`${base}/config`, { engine: 'codex', keyPath: 'mcp_servers.evil.command', value: 'sh' }, { origin })
    expect(blocked.status).toBe(400)
    expect(await blocked.json()).toMatchObject({ ok: false, code: 'CONFIG_KEY_NOT_ALLOWED' })
    expect(manager.writeConfig).not.toHaveBeenCalled()

    const nested = await postJson(`${base}/config`, { engine: 'claude-code', keyPath: 'permissions', value: {} }, { origin })
    expect(nested.status).toBe(400)
    expect(manager.writeConfig).not.toHaveBeenCalled()

    const allowed = await postJson(`${base}/config`, { engine: 'claude-code', keyPath: 'permissions.defaultMode', value: 'acceptEdits' }, { origin })
    expect(allowed.status).toBe(200)
    expect(manager.writeConfig).toHaveBeenCalledWith(expect.objectContaining({ engine: 'claude-code', keyPath: 'permissions.defaultMode' }))
  })
})
