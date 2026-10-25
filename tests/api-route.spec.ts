import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCodingAgentsRoute } from '../src/api-route.ts'
import type { CodingAgentsManager } from '../src/manager.ts'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function serve(manager: Partial<CodingAgentsManager>): Promise<string> {
  const server = createServer(createCodingAgentsRoute(manager as CodingAgentsManager))
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing address')
  return `http://127.0.0.1:${address.port}/coding-agents-api`
}

describe('coding agents HTTP API', () => {
  it('returns status and combined sessions', async () => {
    const manager = {
      installations: vi.fn(() => [{ engine: 'codex', available: true }]),
      runningCount: vi.fn(() => 0),
      maximumConcurrentRuns: 4,
      list: vi.fn(async () => [{ engine: 'codex', id: '1', title: 'one', preview: '', updatedAt: 1 }]),
    }
    const base = await serve(manager)
    const status = await fetch(`${base}/status`).then(response => response.json())
    expect(status).toMatchObject({ ok: true, running: 0, maximumConcurrentRuns: 4 })
    const sessions = await fetch(`${base}/sessions?engine=all&limit=10`).then(response => response.json())
    expect(sessions).toMatchObject({ ok: true, sessions: [{ id: '1' }] })
  })

  it('validates run requests before starting them', async () => {
    const manager = { start: vi.fn() }
    const base = await serve(manager)
    const result = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'unknown', mode: 'new', prompt: 'x' }),
    }).then(response => response.json())
    expect(result).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(manager.start).not.toHaveBeenCalled()
  })
})
