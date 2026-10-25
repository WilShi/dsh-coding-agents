import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ASAR_SEGMENT = /([\\/])app\.asar([\\/])/u

/**
 * Electron's patched fs APIs can read files from app.asar, but Windows and
 * POSIX cannot execute a native binary from that virtual path. electron-builder
 * publishes native package files under app.asar.unpacked, so translate only
 * when that physical counterpart is present.
 */
export function executableOutsideAsar(
  path: string,
  exists: (candidate: string) => boolean = existsSync,
): string {
  const unpacked = path.replace(ASAR_SEGMENT, '$1app.asar.unpacked$2')
  return unpacked !== path && exists(unpacked) ? unpacked : path
}

/** Resolve one executable shipped by an optional platform package. */
export function resolveNativePackageExecutable(packageName: string, ...segments: string[]): string {
  const manifest = require.resolve(`${packageName}/package.json`)
  const executable = executableOutsideAsar(join(dirname(manifest), ...segments))
  if (!existsSync(executable)) {
    throw new Error(`内置编程助手缺少原生程序：${packageName} (${executable})`)
  }
  return executable
}
