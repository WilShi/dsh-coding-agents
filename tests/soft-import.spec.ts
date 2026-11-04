import { describe, expect, it, vi } from 'vitest'
import { spawn as spawnChild } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Host-without-vendor-packages scenario, as observed in the real 0.2.1 E2E:
 * neither the platform-native CLI nor the optional peer packages are present.
 * `node:module` is mocked so every vendor package import/resolve throws, which
 * proves the plugin no longer needs them while it is being imported.
 */
const state = vi.hoisted(() => ({ blockedResolves: 0 }))

const BLOCKED = ['@anthropic-ai/claude-agent-sdk', '@openai/codex']

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  const blocked = (id: string): boolean =>
    BLOCKED.some(prefix => id === prefix || id.startsWith(prefix + '/') || id.startsWith(prefix + '-'))
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

/** Host subprocess stub that really runs the command (used by the version probe). */
function realSubprocess() {
  return {
    spawn(spec: { argv: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) {
      const child = spawnChild(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] })
      if (spec.signal !== undefined) spec.signal.addEventListener('abort', () => child.kill(), { once: true })
      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))
      })
      return {
        stdin: undefined,
        stdout: child.stdout,
        stderr: child.stderr,
        collected: {},
        done,
        terminate() { child.kill() },
        async waitForExit() { return true },
      }
    },
  } as never
}

async function fakeCli(directory: string, name: string, version: string): Promise<void> {
  const path = join(directory, name)
  await writeFile(path, '#!/bin/sh\necho "' + name + '-cli ' + version + '"\n', { encoding: 'utf8', mode: 0o755 })
  await chmod(path, 0o755)
}

function hooks() {
  return { signal: new AbortController().signal, onSession: () => {}, onTurn: () => {}, onEvent: () => {}, onOutput: () => {} }
}

describe('fail-soft vendor resolution', () => {
  it('imports the plugin modules without resolving any vendor package', async () => {
    const claude = await import('../src/claude-controller.ts')
    const codex = await import('../src/codex-controller.ts')
    const managerModule = await import('../src/manager.ts')
    expect(typeof claude.ClaudeController).toBe('function')
    expect(typeof codex.CodexController).toBe('function')
    expect(typeof managerModule.CodingAgentsManager).toBe('function')
    expect(state.blockedResolves).toBe(0)
  })

  it('reports both engines unavailable with actionable reasons when nothing is installed', async () => {
    const { CodingAgentsManager } = await import('../src/manager.ts')
    const empty = await mkdtemp(join(tmpdir(), 'dsh-ca-none-'))
    const previous = process.env.PATH
    process.env.PATH = empty
    try {
      const manager = new CodingAgentsManager(realSubprocess(), 4)
      try {
        const installations = await manager.installations()
        expect(installations).toHaveLength(2)
        expect(installations.every(item => !item.available)).toBe(true)
        expect(installations[0]?.diagnostic).toContain('1)')
        expect(installations[1]?.diagnostic).toContain('Claude Agent SDK')
        expect(() => manager.start({ engine: 'codex', mode: 'new', prompt: 'x' })).toThrow(/未找到可用的 Codex/u)
      } finally {
        await manager.dispose()
      }
    } finally {
      process.env.PATH = previous
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('uses a system CLI from PATH and probes its version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ca-system-'))
    const previous = process.env.PATH
    process.env.PATH = directory
    try {
      await fakeCli(directory, 'codex', '1.4.2')
      await fakeCli(directory, 'claude', '9.8.7')
      const { CodingAgentsManager } = await import('../src/manager.ts')
      const manager = new CodingAgentsManager(realSubprocess(), 4)
      try {
        const installations = await manager.installations()
        const codex = installations.find(item => item.engine === 'codex')
        expect(codex).toMatchObject({ available: true, source: 'system', version: '1.4.2' })
        const claude = installations.find(item => item.engine === 'claude-code')
        // The SDK peer is blocked in this module graph, so only the CLI is known.
        expect(claude?.source).toBe('system')
        expect(claude?.version).toBe('9.8.7')
        expect(claude?.available).toBe(false)
        expect(claude?.diagnostic).toContain('Claude Agent SDK')
      } finally {
        await manager.dispose()
      }
    } finally {
      process.env.PATH = previous
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('prefers a configured command over the system PATH', async () => {
    const system = await mkdtemp(join(tmpdir(), 'dsh-ca-sys-'))
    const custom = await mkdtemp(join(tmpdir(), 'dsh-ca-cfg-'))
    const previous = process.env.PATH
    process.env.PATH = system
    try {
      await fakeCli(system, 'codex', '1.0.0')
      const configured = join(custom, 'my-codex')
      await fakeCli(custom, 'my-codex', '5.5.5')
      const { CodexController } = await import('../src/codex-controller.ts')
      const controller = new CodexController(realSubprocess(), { codexCommand: configured })
      expect(controller.source).toBe('config')
      expect(controller.executable).toBe(configured)
      expect(await controller.version()).toBe('5.5.5')
    } finally {
      process.env.PATH = previous
      await rm(system, { recursive: true, force: true })
      await rm(custom, { recursive: true, force: true })
    }
  })
})
