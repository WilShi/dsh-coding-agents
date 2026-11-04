/**
 * Lazy Claude Agent SDK access.
 *
 * The SDK is an optional peer dependency: a host may run this plugin with only
 * a Codex CLI installed. Nothing here touches the SDK while the plugin module is
 * being imported; the first Claude Code operation (or a status probe) loads it
 * and caches either the module or an actionable failure.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const PACKAGE = '@anthropic-ai/claude-agent-sdk'

/** The SDK module surface, typed statically from the installed devDependency. */
export type ClaudeSdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

let loaded: Promise<ClaudeSdkModule> | undefined
let failure: Error | undefined

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The actionable message used whenever the SDK is missing. */
export function claudeSdkUnavailableReason(detail?: string): string {
  const why = detail === undefined ? '' : '：' + detail
  return '未安装 Claude Agent SDK（' + PACKAGE + '）' + why + '。请执行 "npm i ' + PACKAGE + '"（或在 profile 目录 "pnpm add ' + PACKAGE + '"）后重启；只使用 Codex 引擎时不影响插件。'
}

/** Whether the SDK package can be resolved, without importing it. */
export function claudeSdkInstalled(): boolean {
  try {
    require.resolve(PACKAGE)
    return true
  } catch {
    return false
  }
}

/** SDK version from its manifest, when installed. */
export function claudeSdkVersion(): string | undefined {
  try {
    const entry = require.resolve(PACKAGE)
    const manifest = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { version?: string }
    return manifest.version
  } catch {
    return undefined
  }
}

/**
 * Load the SDK module on first use.
 * @returns the module namespace.
 * @throws the cached actionable error when the SDK is not installed.
 */
export async function loadClaudeSdk(): Promise<ClaudeSdkModule> {
  if (failure !== undefined) throw failure
  loaded ??= import(PACKAGE).then(
    module => module,
    (error: unknown) => {
      failure = new Error(claudeSdkUnavailableReason(messageOf(error)))
      throw failure
    },
  )
  return loaded
}
