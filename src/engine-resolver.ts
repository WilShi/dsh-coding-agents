/**
 * Version-agnostic engine discovery.
 *
 * The plugin never pins the user's Codex / Claude Code installation. For every
 * engine it resolves, lazily and independently, in this order:
 *
 * 1. `config.codexCommand` / `config.claudeCommand` (absolute path or a name on PATH);
 * 2. the system `PATH` (`codex` / `claude`, plus Windows executable extensions);
 * 3. the CLI shipped inside this package's optional vendor dependency;
 * 4. nothing — the engine reports an actionable "unavailable" state.
 *
 * Resolution is filesystem-only and synchronous; the version string is probed
 * with `<cli> --version` on first use and cached.
 */

import { existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { scrubbedParentEnv, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { CodingAgentEngine, CodingAgentInstallSource } from './types.ts'

/** The subprocess surface the version probe needs. */
export type SubprocessFace = Pick<SubprocessRuntime, 'spawn'>

/** Synchronous resolution outcome, cached per engine. */
interface Resolution {
  readonly source?: CodingAgentInstallSource
  readonly command?: string
  readonly reason?: string
}

export interface EngineCliOptions {
  /** Engine identifier used in messages. */
  readonly engine: CodingAgentEngine
  /** Display label used in messages ("Codex", "Claude Code"). */
  readonly label: string
  /** `config.codexCommand` / `config.claudeCommand`; empty string means auto. */
  readonly configured?: string
  /** Resolve the CLI that ships inside this package; throws when not installed. */
  readonly bundled: () => string
  /** Host subprocess service used for the `--version` probe. */
  readonly subprocess: SubprocessFace
  /** PATH used for the system lookup; defaults to `process.env.PATH`. */
  readonly pathVariable?: string
  /** Platform override for tests. */
  readonly platform?: NodeJS.Platform
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return false
    // Windows has no POSIX execute bit; existence plus an executable extension
    // is what the shell accepts.
    return platform === 'win32' || (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** Executable name candidates, including the Windows extensions. */
function commandCandidates(name: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [name]
  return [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]
}

/**
 * Find one command name on a PATH-style variable.
 * @param name - command name or relative/absolute path.
 * @param pathVariable - PATH content to search.
 * @param platform - target platform.
 * @returns the absolute path, or undefined when no candidate is executable.
 */
export function findOnPath(name: string, pathVariable: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  for (const directory of (pathVariable ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const candidate of commandCandidates(name, platform)) {
      const path = resolve(directory, candidate)
      if (isExecutableFile(path, platform)) return path
    }
  }
  return undefined
}

/** Actionable "no CLI anywhere" message with the three supported fixes. */
export function engineUnavailableMessage(engine: CodingAgentEngine, label: string, configured: string | undefined): string {
  const configKey = engine === 'codex' ? 'codexCommand' : 'claudeCommand'
  const cli = engine === 'codex' ? 'codex' : 'claude'
  const vendorPackage = engine === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-agent-sdk'
  const lines = [
    `未找到可用的 ${label} 命令行程序。可以任选一种方式：`,
    `1) 全局安装并用系统 PATH：安装 ${label} CLI 后确认终端里能直接运行 '${cli} --version'；`,
    `2) 装进当前 profile：在 DSH profile 目录执行 'pnpm add ${vendorPackage}'（或用 'dsh plugin --profile <name> add'）；`,
    `3) 在插件 config 里指定路径：${configKey}: /absolute/path/to/${cli}。`,
  ]
  if (configured !== undefined && configured !== '') {
    lines.push(`当前 ${configKey} 配置为「${configured}」，但它不存在或不可执行。`)
  }
  return lines.join('\n')
}

/** Resolve one engine CLI synchronously; throws the actionable message when absent. */
export function resolveEngineCommand(options: {
  readonly engine: CodingAgentEngine
  readonly label: string
  readonly configured?: string
  readonly bundled: () => string
  readonly pathVariable?: string
  readonly platform?: NodeJS.Platform
}): { source: CodingAgentInstallSource; command: string } {
  const platform = options.platform ?? process.platform
  const configured = options.configured?.trim()
  if (configured !== undefined && configured !== '') {
    const command = isAbsolute(configured)
      ? (isExecutableFile(configured, platform) ? configured : undefined)
      : findOnPath(configured, options.pathVariable ?? process.env.PATH, platform)
    if (command === undefined) {
      throw new Error(engineUnavailableMessage(options.engine, options.label, configured))
    }
    return { source: 'config', command }
  }
  const systemName = options.engine === 'codex' ? 'codex' : 'claude'
  const system = findOnPath(systemName, options.pathVariable ?? process.env.PATH, platform)
  if (system !== undefined) return { source: 'system', command: system }
  try {
    return { source: 'bundled', command: options.bundled() }
  } catch {
    throw new Error(engineUnavailableMessage(options.engine, options.label, undefined))
  }
}

/**
 * Extract the first semantic version from CLI `--version` output.
 * @param text - combined stdout/stderr of the probe.
 * @returns the version, or undefined when none is present.
 */
export function parseCliVersion(text: string): string | undefined {
  const match = /(?:^|\s)[vV]?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/u.exec(text)
  return match?.[1]
}

/** Read one CLI's version; never throws and is cached per command. */
function createVersionProbe(subprocess: SubprocessFace, command: string): () => Promise<string | undefined> {
  let cached: Promise<string | undefined> | undefined
  return () => {
    cached ??= (async () => {
      try {
        const signal = AbortSignal.timeout(5_000)
        const child = subprocess.spawn({
          argv: [command, '--version'],
          cwd: process.cwd(),
          env: scrubbedParentEnv(),
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
          graceMs: 1_500,
          signal,
        })
        const chunks: string[] = []
        const capture = (chunk: unknown): void => {
          chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
        }
        child.stdout?.on('data', capture)
        child.stderr?.on('data', capture)
        const outcome = await child.done
        if (outcome.exitCode !== 0) return undefined
        return parseCliVersion(chunks.join('\n'))
      } catch {
        return undefined
      }
    })()
    return cached
  }
}

/**
 * One engine's lazily resolved CLI: source, executable and cached version.
 * Resolution never throws; callers that need the executable get an actionable
 * error instead.
 */
export class EngineCli {
  readonly #options: EngineCliOptions
  #resolution: Resolution | undefined
  #probe: (() => Promise<string | undefined>) | undefined

  constructor(options: EngineCliOptions) {
    this.#options = options
  }

  /** Resolution result, computed once (filesystem only). */
  get #resolved(): Resolution {
    if (this.#resolution === undefined) {
      try {
        const { source, command } = resolveEngineCommand(this.#options)
        this.#resolution = { source, command }
      } catch (error) {
        this.#resolution = { reason: messageOf(error) }
      }
    }
    return this.#resolution
  }

  /** Whether a CLI was found. */
  get available(): boolean {
    return this.#resolved.command !== undefined
  }

  /** Actionable reason the engine has no CLI, if any. */
  get reason(): string | undefined {
    return this.#resolved.reason
  }

  /** Where the CLI came from. */
  get source(): CodingAgentInstallSource | undefined {
    return this.#resolved.source
  }

  /** Resolved executable path, when available. */
  get commandOrUndefined(): string | undefined {
    return this.#resolved.command
  }

  /** Resolved executable path; throws the actionable reason when unavailable. */
  get command(): string {
    const command = this.#resolved.command
    if (command === undefined) throw new Error(this.#resolved.reason ?? engineUnavailableMessage(this.#options.engine, this.#options.label, undefined))
    return command
  }

  /** Cached `<cli> --version` result; resolves undefined when the probe fails. */
  version(): Promise<string | undefined> {
    const command = this.#resolved.command
    if (command === undefined) return Promise.resolve(undefined)
    this.#probe ??= createVersionProbe(this.#options.subprocess, command)
    return this.#probe()
  }

  /** The configured command string (diagnostics only). */
  get configured(): string | undefined {
    return this.#options.configured
  }
}
