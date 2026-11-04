import { describe, expect, it, vi } from 'vitest'
import { spawn as spawnChild } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EngineCli, engineUnavailableMessage, findOnPath, parseCliVersion, resolveEngineCommand } from '../src/engine-resolver.ts'

/** Host subprocess stub that really runs the command, like the DSH seam does. */
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

async function fakeCli(directory: string, name: string, version: string): Promise<string> {
  const path = join(directory, name)
  await writeFile(path, '#!/bin/sh\necho "' + name + ' ' + version + '"\n', { encoding: 'utf8', mode: 0o755 })
  await chmod(path, 0o755)
  return path
}

describe('engine resolver', () => {
  it('parses versions from real CLI output shapes', () => {
    expect(parseCliVersion('codex-cli 0.153.4')).toBe('0.153.4')
    expect(parseCliVersion('2.1.278 (Claude Code)')).toBe('2.1.278')
    expect(parseCliVersion('v1.2.3-beta.1')).toBe('1.2.3-beta.1')
    expect(parseCliVersion('no version here')).toBeUndefined()
  })

  it('resolves config > system PATH > bundled and refuses with an actionable message', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ca-resolver-'))
    const empty = await mkdtemp(join(tmpdir(), 'dsh-ca-empty-'))
    try {
      const configCli = await fakeCli(directory, 'my-codex', '9.9.9')
      const systemCli = await fakeCli(directory, 'codex', '1.2.3')
      const bundled = vi.fn(() => '/bundled/codex')

      expect(resolveEngineCommand({ engine: 'codex', label: 'Codex', configured: configCli, bundled, pathVariable: directory }))
        .toEqual({ source: 'config', command: configCli })
      expect(resolveEngineCommand({ engine: 'codex', label: 'Codex', configured: undefined, bundled, pathVariable: directory }))
        .toEqual({ source: 'system', command: systemCli })
      expect(resolveEngineCommand({ engine: 'codex', label: 'Codex', configured: undefined, bundled, pathVariable: empty }))
        .toEqual({ source: 'bundled', command: '/bundled/codex' })
      const refusing = vi.fn(() => { throw new Error('missing') })
      expect(() => resolveEngineCommand({ engine: 'claude-code', label: 'Claude Code', configured: undefined, bundled: refusing, pathVariable: empty }))
        .toThrow(/未找到可用的 Claude Code 命令行程序/u)
      expect(() => resolveEngineCommand({ engine: 'claude-code', label: 'Claude Code', configured: undefined, bundled: refusing, pathVariable: empty }))
        .toThrow(/claudeCommand/u)
      expect(engineUnavailableMessage('codex', 'Codex', undefined)).toContain('1)')
      expect(engineUnavailableMessage('codex', 'Codex', undefined)).toContain('config 里指定路径')
    } finally {
      await rm(directory, { recursive: true, force: true })
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('probes and caches the CLI version through the subprocess service', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ca-probe-'))
    try {
      const cli = await fakeCli(directory, 'codex-probe', '7.7.7')
      const subprocess = realSubprocess()
      const engine = new EngineCli({ engine: 'codex', label: 'Codex', configured: cli, bundled: () => { throw new Error('unused') }, subprocess })
      expect(engine.source).toBe('config')
      const spawnSpy = vi.spyOn(subprocess as unknown as { spawn: (...args: never[]) => unknown }, 'spawn')
      expect(await engine.version()).toBe('7.7.7')
      expect(await engine.version()).toBe('7.7.7')
      expect(spawnSpy).toHaveBeenCalledTimes(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('finds executables on a PATH-style variable only when executable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ca-path-'))
    try {
      const plain = join(directory, 'codex')
      await writeFile(plain, 'not executable', { encoding: 'utf8', mode: 0o644 })
      expect(findOnPath('codex', directory, 'linux')).toBeUndefined()
      await chmod(plain, 0o755)
      expect(findOnPath('codex', directory, 'linux')).toBe(plain)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
