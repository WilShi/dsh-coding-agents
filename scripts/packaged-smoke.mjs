import { spawn as spawnChild, spawnSync } from 'node:child_process'
import { CodingAgentsManager } from '../lib/manager.js'

function environment(overlay = {}) {
  const value = { ...process.env }
  for (const [key, next] of Object.entries(overlay)) {
    if (next === undefined) delete value[key]
    else value[key] = next
  }
  return value
}

const subprocess = {
  spawn(spec) {
    const child = spawnChild(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: environment(spec.env),
      windowsHide: true,
      stdio: ['pipe', 'pipe', spec.stdio.stderr === 'inherit' ? 'inherit' : 'pipe'],
    })
    let outcome
    const done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (exitCode, signal) => {
        outcome = { exitCode, signal }
        resolve(outcome)
      })
    })
    if (spec.signal !== undefined) spec.signal.addEventListener('abort', () => child.kill(), { once: true })
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      done,
      terminate() { child.kill() },
      async waitForExit(signal) {
        if (outcome !== undefined) return outcome
        return await Promise.race([
          done,
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason ?? new Error('wait aborted')), { once: true })),
        ])
      },
    }
  },
}

const manager = new CodingAgentsManager(subprocess)
try {
  const installations = manager.installations()
  if (installations.length !== 2 || installations.some(item => !item.available)) {
    throw new Error('packaged coding-agent installations are incomplete')
  }
  if (import.meta.url.includes('app.asar')) {
    for (const installation of installations) {
      if (!installation.executable.includes('app.asar.unpacked')) {
        throw new Error(`${installation.label} executable did not map to app.asar.unpacked: ${installation.executable}`)
      }
    }
  }

  // Codex history uses the App Server and therefore proves a real JSON-RPC
  // initialize/list/shutdown cycle against the packaged native executable.
  await manager.list({ engine: 'codex', limit: 1 })
  await manager.config('codex')

  // Claude history/config is file-backed; verify those APIs and launch the
  // exact executable that the SDK receives without making a model request.
  await manager.list({ engine: 'claude-code', limit: 1 })
  await manager.config('claude-code')
  for (const installation of installations) {
    const version = spawnSync(installation.executable, ['--version'], {
      env: environment(),
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })
    if (version.error !== undefined) throw version.error
    if (version.status !== 0) {
      throw new Error(`${installation.label} --version exited with ${String(version.status)}: ${version.stderr.trim()}`)
    }
  }
  process.stdout.write('DSH_PACKAGED_CODING_AGENTS_OK\n')
} finally {
  await manager.dispose()
}
