import { describe, expect, it, vi } from 'vitest'

/**
 * Host-without-native-packages scenario, as observed in the real 0.2.1 E2E:
 * pnpm can skip the platform-specific optional dependency, which used to make
 * the whole plugin fail to import. `node:module` is mocked so that
 * `require.resolve('@anthropic-ai/claude-agent-sdk-<platform>-<arch>')` and
 * `require.resolve('@openai/codex-<platform>-<arch>')` throw MODULE_NOT_FOUND
 * while every other module keeps resolving normally.
 */
const state = vi.hoisted(() => ({ blockedResolves: 0 }))

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  const blocked = (id: string): boolean =>
    id.startsWith('@anthropic-ai/claude-agent-sdk-') || id.startsWith('@openai/codex-')
  const wrap = (real: NodeJS.Require): NodeJS.Require => {
    const callable = ((id: string) => {
      if (blocked(id)) {
        state.blockedResolves += 1
        throw new Error(`Cannot find module '${id}'`)
      }
      return real(id)
    }) as unknown as NodeJS.Require
    callable.resolve = ((id: string, options?: { paths?: string[] }) => {
      if (blocked(id)) {
        state.blockedResolves += 1
        throw new Error(`Cannot find module '${id}'`)
      }
      return real.resolve(id, options as never)
    }) as NodeJS.RequireResolve
    callable.cache = real.cache
    callable.extensions = real.extensions
    callable.main = real.main
    return callable
  }
  return { ...actual, createRequire: (url: string | URL) => wrap(actual.createRequire(url)) }
})

const subprocess = { spawn: vi.fn(() => { throw new Error('no process may be spawned') }) } as never

function claudeHooks() {
  return {
    signal: new AbortController().signal,
    onSession: () => {},
    onEvent: () => {},
    onOutput: () => {},
  }
}

function codexHooks() {
  return { ...claudeHooks(), onTurn: () => {} }
}

describe('fail-soft native resolution', () => {
  it('imports both controllers without resolving a native package', async () => {
    const claude = await import('../src/claude-controller.ts')
    const codex = await import('../src/codex-controller.ts')
    expect(typeof claude.ClaudeController).toBe('function')
    expect(typeof codex.CodexController).toBe('function')
    expect(state.blockedResolves).toBe(0)
  })

  it('marks claude-code unavailable with an actionable reason instead of failing', async () => {
    const { ClaudeController } = await import('../src/claude-controller.ts')
    const controller = new ClaudeController(subprocess)
    expect(controller.available).toBe(false)
    expect(controller.executablePath).toBeUndefined()
    expect(controller.unavailableReason).toContain('@anthropic-ai/claude-agent-sdk-')
    expect(controller.unavailableReason).toContain('optional')
    await expect(controller.execute({ engine: 'claude-code', mode: 'new', prompt: 'hello' }, claudeHooks()))
      .rejects.toThrow(/重新安装 dsh-coding-agents/u)
  })

  it('marks codex unavailable with an actionable reason instead of failing', async () => {
    const { CodexController } = await import('../src/codex-controller.ts')
    const controller = new CodexController(subprocess)
    expect(controller.available).toBe(false)
    expect(controller.executablePath).toBeUndefined()
    expect(controller.unavailableReason).toContain('@openai/codex-')
    expect(controller.unavailableReason).toContain('optional')
    await expect(controller.execute({ engine: 'codex', mode: 'new', prompt: 'hello' }, codexHooks()))
      .rejects.toThrow(/重新安装 dsh-coding-agents/u)
  })

  it('keeps manager status and start fail-soft and actionable', async () => {
    const { CodingAgentsManager } = await import('../src/manager.ts')
    const manager = new CodingAgentsManager(subprocess, 4)
    try {
      const installations = manager.installations()
      expect(installations).toHaveLength(2)
      expect(installations.every(item => item.available)).toBe(false)
      expect(installations.every(item => item.executable === undefined)).toBe(true)
      expect(installations.every(item => (item.diagnostic ?? '').includes('optional'))).toBe(true)
      expect(() => manager.start({ engine: 'codex', mode: 'new', prompt: 'x' })).toThrow(/optional/u)
      expect(() => manager.start({ engine: 'claude-code', mode: 'new', prompt: 'x' })).toThrow(/optional/u)
    } finally {
      await manager.dispose()
    }
  })
})
