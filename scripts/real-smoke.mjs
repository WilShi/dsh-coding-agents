import { spawn as spawnChild } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const execute = process.argv.includes('--execute')
const manager = new CodingAgentsManager(subprocess)
const workspace = await mkdtemp(join(tmpdir(), 'dsh-coding-agents-smoke-'))
const report = { status: manager.installations(), history: {}, configurations: {}, executions: {} }

try {
  for (const engine of ['codex', 'claude-code']) {
    const config = await manager.config(engine, workspace)
    report.configurations[engine] = { sourceCount: config.sources.length, editableTargets: config.editableTargets }
    const sessions = await manager.list({ engine, limit: 3 })
    report.history[engine] = {
      count: sessions.length,
      sample: sessions.map(item => ({ id: item.id, title: item.title, cwd: item.cwd, updatedAt: item.updatedAt })),
    }
    if (sessions[0] !== undefined) {
      const detail = await manager.detail(engine, sessions[0].id, sessions[0].cwd)
      report.history[engine].detailMessages = detail.messages.length
    }
  }

  if (execute) {
    for (const engine of ['codex', 'claude-code']) {
      const started = manager.start({
        engine,
        mode: 'new',
        cwd: workspace,
        permission: 'read-only',
        prompt: 'This is a DSH integration smoke test. Do not use tools, access the network, or change files. Reply with exactly DSH_CODING_AGENT_SMOKE_OK.',
      })
      const timeout = AbortSignal.timeout(180_000)
      const result = await manager.wait(started.id, timeout)
      const originalSessionId = result.sessionId
      if (originalSessionId === undefined) throw new Error(`${engine} did not persist its smoke session`)
      await manager.mutate({ engine, sessionId: originalSessionId, cwd: workspace, action: 'rename', title: 'DSH 编程助手自动回归' })
      if (engine === 'claude-code') await manager.mutate({ engine, sessionId: originalSessionId, cwd: workspace, action: 'tag', tag: 'dsh-smoke' })
      const resumed = manager.start({
        engine,
        mode: 'resume',
        sessionId: originalSessionId,
        cwd: workspace,
        permission: 'read-only',
        prompt: 'Do not use tools. Reply with exactly DSH_RESUME_OK.',
      })
      const resumeResult = await manager.wait(resumed.id, AbortSignal.timeout(180_000))
      if (resumeResult.state !== 'completed' || !resumeResult.output.includes('DSH_RESUME_OK')) throw new Error(`${engine} resume failed: ${resumeResult.error ?? resumeResult.output}`)
      const forked = manager.start({
        engine,
        mode: 'fork',
        sessionId: originalSessionId,
        cwd: workspace,
        permission: 'read-only',
        prompt: 'Do not use tools. Reply with exactly DSH_FORK_OK.',
      })
      const forkResult = await manager.wait(forked.id, AbortSignal.timeout(180_000))
      if (forkResult.state !== 'completed' || !forkResult.output.includes('DSH_FORK_OK') || forkResult.sessionId === undefined || forkResult.sessionId === originalSessionId) {
        throw new Error(`${engine} fork failed: ${forkResult.error ?? forkResult.output}`)
      }
      const detail = await manager.detail(engine, originalSessionId, workspace, 20)
      report.executions[engine] = {
        state: result.state,
        sessionId: originalSessionId,
        output: result.output,
        error: result.error,
        eventTypes: [...new Set(result.events.map(event => event.type))],
        renamedTitle: detail.title,
        totalMessagesAfterResume: detail.totalMessageCount,
        resumeOutput: resumeResult.output,
        forkSessionId: forkResult.sessionId,
        forkOutput: forkResult.output,
      }
      if (result.state !== 'completed' || !result.output.includes('DSH_CODING_AGENT_SMOKE_OK')) {
        throw new Error(`${engine} smoke execution failed: ${result.error ?? result.output}`)
      }
      await manager.mutate({ engine, sessionId: forkResult.sessionId, cwd: workspace, action: 'delete' })
      await manager.mutate({ engine, sessionId: originalSessionId, cwd: workspace, action: 'delete' })
    }
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  await manager.dispose()
  await rm(workspace, { recursive: true, force: true })
}
