import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodingAgentsManager } from '../src/manager.ts'

function manager(maximum = 4): CodingAgentsManager {
  return new CodingAgentsManager({ spawn: () => { throw new Error('unexpected spawn') } } as never, maximum)
}

describe('CodingAgentsManager', () => {
  it('merges both history sources by update time', async () => {
    const subject = manager()
    vi.spyOn(subject.codex, 'list').mockResolvedValue([{ engine: 'codex', id: 'c1', title: 'Codex', preview: '', updatedAt: 10 }])
    vi.spyOn(subject.claude, 'list').mockResolvedValue([{ engine: 'claude-code', id: 'a1', title: 'Claude', preview: '', updatedAt: 20 }])
    await expect(subject.list({ engine: 'all', limit: 10 })).resolves.toEqual([
      expect.objectContaining({ id: 'a1' }),
      expect.objectContaining({ id: 'c1' }),
    ])
    await subject.dispose()
  })

  it('tracks a completed run and its streamed events', async () => {
    const subject = manager()
    vi.spyOn(subject.codex, 'execute').mockImplementation(async (_request, hooks) => {
      hooks.onSession('thread-1')
      hooks.onTurn('turn-1')
      hooks.onEvent('tool', '开始：shell')
      hooks.onOutput('完成')
      return { sessionId: 'thread-1', turnId: 'turn-1', output: '完成' }
    })
    const started = subject.start({ engine: 'codex', mode: 'new', prompt: 'test' })
    const result = await subject.wait(started.id)
    expect(result).toMatchObject({ state: 'completed', sessionId: 'thread-1', turnId: 'turn-1', output: '完成' })
    expect(result.events.map(event => event.text)).toContain('开始：shell')
    await subject.dispose()
  })

  it('cancels a running Claude Code task', async () => {
    const subject = manager()
    vi.spyOn(subject.claude, 'execute').mockImplementation(async (_request, hooks) => {
      await new Promise<void>(resolve => hooks.signal.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('aborted')
    })
    const started = subject.start({ engine: 'claude-code', mode: 'new', prompt: 'wait' })
    subject.cancel(started.id)
    await expect(subject.wait(started.id)).resolves.toMatchObject({ state: 'cancelled' })
    await subject.dispose()
  })

  it('enforces the configured concurrency limit', async () => {
    const subject = manager(1)
    vi.spyOn(subject.codex, 'execute').mockImplementation(async (_request, hooks) => {
      await new Promise<void>(resolve => hooks.signal.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('aborted')
    })
    const first = subject.start({ engine: 'codex', mode: 'new', prompt: 'one' })
    expect(() => subject.start({ engine: 'codex', mode: 'new', prompt: 'two' })).toThrow(/1 个编程助手任务/u)
    subject.cancel(first.id)
    await subject.wait(first.id)
    await subject.dispose()
  })

  it('backs up and atomically updates Claude Code user settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-coding-agent-config-'))
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = directory
    const subject = manager()
    try {
      await subject.writeConfig({ engine: 'claude-code', target: 'user', keyPath: 'model', value: 'first' })
      await subject.writeConfig({ engine: 'claude-code', target: 'user', keyPath: 'model', value: 'second' })
      expect(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))).toMatchObject({ model: 'second' })
      expect((await readdir(directory)).some(name => name.startsWith('settings.json.backup-dsh-'))).toBe(true)
    } finally {
      await subject.dispose()
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
      await rm(directory, { recursive: true, force: true })
    }
  })
})
