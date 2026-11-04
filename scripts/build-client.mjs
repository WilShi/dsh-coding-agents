/**
 * Client bundle build: esbuild-bundles src-client/index.tsx to browser CJS with
 * every module the DSH web shell provides kept external, then wraps the result
 * in the `window.__ModuleLoader__.load({ id, factory })` closure-factory form the
 * 0.2.1 shell loader expects. CSS modules are compiled with lightningcss into a
 * class map plus an `injectStyles()` disposer owned by `ctx.effect`.
 * Output: lib/client.js.
 */

import { build } from 'esbuild'
import { transform } from 'lightningcss'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'src-client/index.tsx')
const outDir = join(root, 'lib')
const tmpDir = join(outDir, '.tmp')
const tmpFile = join(tmpDir, 'client.cjs')
const outFile = join(outDir, 'client.js')

/** Stable Loader id of the client plugin row (equals the package name). */
const PLUGIN_ID = 'dsh-coding-agents'

/** Browser modules resolved from the DSH shell module table at runtime. */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  'react-dom/server',
  '@deepseek-ai/*',
]

/** Compiles `*.module.css` into a hashed class map plus a style-tag disposer. */
const cssModules = {
  name: 'dsh-coding-agents-css-modules',
  setup(build) {
    build.onResolve({ filter: /\.module\.css$/ }, args => ({
      path: resolve(args.resolveDir, args.path),
      namespace: 'css-module',
    }))
    build.onLoad({ filter: /.*/, namespace: 'css-module' }, async args => {
      const result = transform({
        filename: args.path,
        code: await readFile(args.path),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = {}
      for (const [local, value] of Object.entries(result.exports ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
        classMap[local] = value.name
      }
      const css = result.code.toString()
      const tagId = PLUGIN_ID + '/' + basename(args.path)
      return {
        resolveDir: dirname(args.path),
        loader: 'js',
        contents: [
          'const css = ' + JSON.stringify(css) + ';',
          'const tagId = ' + JSON.stringify(tagId) + ';',
          'export default ' + JSON.stringify(classMap) + ';',
          'export function injectStyles() {',
          '  if (typeof document === "undefined") return () => {};',
          '  if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return () => {};',
          '  const tag = document.createElement("style");',
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '  return () => { tag.remove(); };',
          '}',
        ].join('\n'),
      }
    })
  },
}

await mkdir(tmpDir, { recursive: true })

try {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'react',
    external: EXTERNALS,
    plugins: [cssModules],
    outfile: tmpFile,
    sourcemap: false,
    minify: false,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  })

  const cjs = await readFile(tmpFile, 'utf8')
  const wrapped = [
    'window.__ModuleLoader__.load({',
    '  id: ' + JSON.stringify(PLUGIN_ID) + ',',
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    cjs.replace(/\n$/, ''),
    '    return module.exports;',
    '  }',
    '});',
    '',
  ].join('\n')

  await mkdir(outDir, { recursive: true })
  await writeFile(outFile, wrapped, 'utf8')
  console.log('client bundle written: ' + outFile + ' (' + String(wrapped.length) + ' bytes)')
} finally {
  await rm(tmpDir, { recursive: true, force: true })
}
