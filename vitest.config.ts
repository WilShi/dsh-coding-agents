import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The client tests import .tsx components; without this the esbuild default
  // is the classic runtime and React is undefined in a fresh install.
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: { environment: 'node' },
})
