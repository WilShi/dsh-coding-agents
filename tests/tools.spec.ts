import { describe, expect, it, vi } from 'vitest'
import type { CodingAgentsManager } from '../src/manager.ts'
import { createCodingAgentTools } from '../src/tools.ts'

function manager(started = vi.fn(() => ({
  id: 'run-1',
  engine: 'codex',
  mode: 'new',
  state: 'starting',
  startedAt: 1,
  output: '',
  events: [],
}))) {
  return { start: started, wait: vi.fn(async () => ({ id: 'run-1', state: 'completed', output: 'ok', events: [] })) } as unknown as CodingAgentsManager
}

function runTool(subject: ReturnType<typeof manager>) {
  const tool = createCodingAgentTools(subject).find(candidate => candidate.name === 'coding_agent_run')
  if (tool === undefined) throw new Error('coding_agent_run tool missing')
  return tool.execute as unknown as (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>
}

const exec = { signal: new AbortController().signal }

describe('coding agent model tools', () => {
  it('refuses full-access so a model cannot self-escalate', async () => {
    const subject = manager()
    // The declared parameter schema no longer lists full-access, so dispatch
    // rejects it before the body runs; the body keeps the same guard.
    await expect(runTool(subject)({
      engine: 'codex', mode: 'new', prompt: 'x', permission: 'full-access',
    }, exec)).rejects.toThrow(/permission/u)
    expect((subject.start as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('still runs with an explicit workspace-write permission', async () => {
    const subject = manager()
    const result = await runTool(subject)({
      engine: 'codex', mode: 'new', prompt: 'x', permission: 'workspace-write',
    }, exec)
    expect(result).toMatchObject({ runId: 'run-1', state: 'completed', output: 'ok' })
    expect((subject.start as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({ permission: 'workspace-write' }))
  })
})
