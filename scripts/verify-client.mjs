/**
 * Post-build gate for lib/client.js: static shape checks (ModuleLoader banner,
 * plugin id, CJS-only body, externalized shell modules), a sandboxed dry-run of
 * the closure factory, and a registration dry-run of the exported apply()
 * against a stub slots service. Exits non-zero on any miss.
 */

import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outFile = join(root, 'lib/client.js')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const bundle = await readFile(outFile, 'utf8')
const size = (await stat(outFile)).size
const firstLine = bundle.split('\n', 1)[0]
const expectedId = pkg.name

const failures = []
const check = (label, ok, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + (detail === '' ? '' : ' — ' + detail))
  if (!ok) failures.push(label)
}

// --- static shape ---------------------------------------------------------
check('first line is the ModuleLoader banner', firstLine === 'window.__ModuleLoader__.load({', firstLine)
check('loader id is the package name', new RegExp('^  id: "' + expectedId + '",$', 'm').test(bundle), 'expected ' + expectedId)
check('factory signature present', /^  factory: \(require\) => \{$/m.test(bundle))
check('factory returns module.exports', /^    return module\.exports;$/m.test(bundle))
check('no ESM import statements', !/^import[\s{]/m.test(bundle))
check('no ESM export statements', !/^export[\s{]/m.test(bundle))
check('no inline source map', !/sourceMappingURL=/.test(bundle))
check('bundle is non-trivial', size > 5_000, String(size) + ' bytes')

// --- externals ------------------------------------------------------------
const ALLOWED = [
  /^react$/,
  /^react\/jsx-runtime$/,
  /^react\/jsx-dev-runtime$/,
  /^react-dom$/,
  /^react-dom\/client$/,
  /^react-dom\/server$/,
  /^@deepseek-ai\//,
]
const requires = [...bundle.matchAll(/\brequire\("([^"]+)"\)/g)].map(match => match[1])
const unique = [...new Set(requires)]
const notExternal = unique.filter(spec => !ALLOWED.some(pattern => pattern.test(spec)))
check('every require() comes from the shell module table', notExternal.length === 0, notExternal.join(', '))
check('react is externalized', unique.includes('react'))
check('react/jsx-runtime is externalized', unique.includes('react/jsx-runtime'))
check('no bundled react copy', !/react-dom\.development\.js|react\.development\.js/.test(bundle))
check('stylesheet injection is deferred to a function', /function injectStyles\(\)/.test(bundle))

// --- sandboxed factory run ------------------------------------------------
const loaderRequire = createRequire(join(root, 'lib/index.js'))
let loaded
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(options) {
        loaded = { id: options.id, exports: options.factory(loaderRequire) }
      },
    },
  },
  console,
  setTimeout,
  clearTimeout,
}
try {
  vm.runInNewContext(bundle, sandbox, { filename: outFile })
  check('factory executes in a bare sandbox', loaded !== undefined)
} catch (error) {
  check('factory executes in a bare sandbox', false, String(error))
}

if (loaded !== undefined) {
  const exported = loaded.exports
  check('loaded id matches the package name', loaded.id === expectedId, loaded.id)
  check('exports apply()', typeof exported.apply === 'function')
  check('exports inject list', Array.isArray(exported.inject) && exported.inject.includes('slots'), JSON.stringify(exported.inject))
  check('exports stable name', exported.name === expectedId, String(exported.name))
  check('default export matches named exports', exported.default?.apply === exported.apply && exported.default?.name === exported.name)

  // --- registration dry-run ------------------------------------------------
  const registrations = []
  const effects = []
  const cleanup = []
  const ctx = {
    effect(execute, label) {
      effects.push(label)
      const dispose = execute()
      if (typeof dispose === 'function') cleanup.push(dispose)
      return () => {}
    },
    slots: {
      inject(key, callback) {
        check('slot inject targets settings.section', key === 'settings.section', String(key))
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  try {
    exported.apply(ctx)
    check('apply() runs against a stub client context', true)
  } catch (error) {
    check('apply() runs against a stub client context', false, String(error))
  }
  check('apply() registers exactly one effect per surface', effects.length === 2, JSON.stringify(effects))
  check('apply() registers one settings section', registrations.length === 1, String(registrations.length))
  const entry = registrations[0]
  if (entry !== undefined) {
    check('registration targets settings.section', entry.options.name === 'settings.section', String(entry.options.name))
    check('registration id is coding-agents', entry.options.id === 'coding-agents', String(entry.options.id))
    check('registration order is 46', entry.options.order === 46, String(entry.options.order))
    check('registration label is a thunk', typeof entry.options.label === 'function' && entry.options.label() === '编程助手')
    check('registration component is a function', typeof entry.component === 'function')
    let injected
    try {
      injected = entry.options.inject()
      check('inject() provides a programming-assistant api', typeof injected.api?.status === 'function' && typeof injected.api?.sessions === 'function')
    } catch (error) {
      check('inject() provides a programming-assistant api', false, String(error))
    }
    check('component only consumes the injected api prop', entry.component.length === 1, String(entry.component.length))
  }
  check('style registration is disposable', typeof cleanup[0] === 'function')
}

if (failures.length > 0) {
  console.error('\nclient bundle verification FAILED — ' + String(failures.length) + ' check(s): ' + failures.join(', '))
  process.exit(1)
}
console.log('\nclient bundle OK')
