/**
 * One value loaded on first use and cached, including its failure.
 *
 * The plugin needs this for everything that depends on packages the host may
 * not have installed: the vendored vendor SDKs and their platform-native
 * binaries. Resolving those while the module is being imported turned "this
 * optional package is missing" into "the whole plugin failed to import"; with a
 * lazy value the import always succeeds and the failure surfaces, with an
 * actionable message, only when the affected engine is actually used.
 */

/** A lazily loaded value with a memoised success or failure. */
export interface LazyValue<T> {
  /**
   * Load the value now (at most once) and return it.
   * @returns the loaded value.
   * @throws the cached actionable error when the load has failed.
   */
  resolve(): T
  /**
   * Load the value now (at most once) if it was never loaded.
   * @returns the value, or undefined when the load failed.
   */
  peek(): T | undefined
  /** The cached failure, once a load has failed. */
  readonly failure: Error | undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build a lazy value.
 * @param load - producer invoked at most once.
 * @param describe - converts the first load failure into an actionable message.
 * @returns the lazy value.
 */
export function createLazy<T>(load: () => T, describe: (message: string) => string): LazyValue<T> {
  let value: T | undefined
  let failed: Error | undefined
  const resolve = (): T => {
    if (value !== undefined) return value
    if (failed !== undefined) throw failed
    try {
      value = load()
      return value
    } catch (error) {
      failed = new Error(describe(messageOf(error)))
      throw failed
    }
  }
  return {
    resolve,
    peek: () => {
      try { return resolve() } catch { return undefined }
    },
    get failure() { return failed },
  }
}
