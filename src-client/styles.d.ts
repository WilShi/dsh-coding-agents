declare module '*.module.css' {
  /** Generated class-name map for the module. */
  const classes: Record<string, string>
  /** Injects this module's stylesheet and returns its removal disposer. */
  export function injectStyles(): () => void
  export default classes
}
