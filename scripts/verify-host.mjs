/**
 * Host contract gate for the built plugin: imports lib/index.js with plain
 * Node, asserts the Cordis plugin export shape (name / inject / apply), loads
 * it into a real `@deepseek-ai/cordis` Context backed by stub host services,
 * and proves the route, the model tools and the effect lifecycle really wire up
 * and tear down. Exits non-zero on any miss.
 */

import { Context, Service } from '@deepseek-ai/cordis'

const failures = []
const check = (label, ok, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + (detail === '' ? '' : ' — ' + detail))
  if (!ok) failures.push(label)
}

class StubWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer')
    this.routes = []
  }
  register(route) {
    if (this.routes.some(item => item.kind === route.kind && item.path === route.path)) {
      throw new Error('duplicate route: ' + route.path)
    }
    this.routes.push(route)
    return () => {
      const index = this.routes.indexOf(route)
      if (index >= 0) this.routes.splice(index, 1)
    }
  }
}

class StubSubprocess extends Service {
  constructor(ctx) {
    super(ctx, 'subprocess')
    this.spawns = []
  }
  spawn(spec) {
    this.spawns.push(spec)
    throw new Error('verify-host never starts real processes')
  }
}

class StubTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
    this.definitions = new Map()
  }
  register(definition) {
    if (this.definitions.has(definition.name)) throw new Error('duplicate tool: ' + definition.name)
    this.definitions.set(definition.name, definition)
    return () => {
      this.definitions.delete(definition.name)
    }
  }
}

// --- module import ---------------------------------------------------------
let host
try {
  host = await import('../lib/index.js')
  check('lib/index.js imports under plain Node', true)
} catch (error) {
  check('lib/index.js imports under plain Node', false, String(error))
  process.exit(1)
}

check('exports a stable plugin name', host.name === 'dsh-coding-agents', String(host.name))
check('exports the required host services', JSON.stringify(host.inject) === JSON.stringify(['webServer', 'subprocess', 'tools']), JSON.stringify(host.inject))
check('exports apply()', typeof host.apply === 'function')
check('default export mirrors named exports', host.default?.apply === host.apply && host.default?.name === host.name && host.default?.inject === host.inject)
check('host entry has no default-only apply shape', host.default?.apply?.constructor?.name === 'AsyncFunction')
check('exports manager + route helpers', typeof host.CodingAgentsManager === 'function' && typeof host.createCodingAgentsRoute === 'function' && host.CODING_AGENTS_API_PREFIX === '/coding-agents-api')

// --- cordis load -----------------------------------------------------------
const app = new Context()
await app.plugin(StubWebServer)
await app.plugin(StubSubprocess)
await app.plugin(StubTools)
check('stub host services are available on the context', typeof app.webServer?.register === 'function' && typeof app.subprocess?.spawn === 'function' && typeof app.tools?.register === 'function')

let fiber
try {
  fiber = await app.plugin(host.default)
  check('cordis accepts the { name, inject, apply } plugin object', true)
} catch (error) {
  check('cordis accepts the { name, inject, apply } plugin object', false, String(error))
}

if (fiber !== undefined) {
  const route = app.webServer.routes[0]
  check('apply() registered exactly one web route', app.webServer.routes.length === 1, String(app.webServer.routes.length))
  check('route is a prefix route on the API path', route !== undefined && route.kind === 'prefix' && route.path === '/coding-agents-api', JSON.stringify({ kind: route?.kind, path: route?.path }))
  check('route handler owns request/response', typeof route?.handler === 'function')

  const names = [...app.tools.definitions.keys()].sort()
  check('apply() registered the six model tools', names.length === 6, JSON.stringify(names))
  check('tools use the coding_agent_ prefix', names.every(name => name.startsWith('coding_agent_')), JSON.stringify(names))
  const definitions = [...app.tools.definitions.values()]
  check('every tool declares parameters, output schema and execute', definitions.every(definition => typeof definition.execute === 'function' && typeof definition.parameters === 'object' && typeof definition.output?.schema === 'object'))
  check('every tool renders canonical output', definitions.every(definition => typeof definition.output?.render === 'function'))

  const labels = fiber.getEffects().map(effect => effect.label).sort()
  check('plugin owns labelled effects', ['dsh-coding-agents: HTTP API', 'dsh-coding-agents: dispose manager', 'dsh-coding-agents: model tools'].every(label => labels.includes(label)), JSON.stringify(labels))

  await fiber.dispose()
  check('unload removed the HTTP route', app.webServer.routes.length === 0, String(app.webServer.routes.length))
  check('unload removed every model tool', app.tools.definitions.size === 0, String(app.tools.definitions.size))
  check('unload disposed the manager effect', fiber.getEffects().length === 0 || fiber.getEffects().every(effect => effect.label !== 'dsh-coding-agents: dispose manager'), JSON.stringify(fiber.getEffects().map(effect => effect.label)))
}

if (failures.length > 0) {
  console.error('\nhost verification FAILED — ' + String(failures.length) + ' check(s): ' + failures.join(', '))
  process.exit(1)
}
console.log('\nhost plugin OK')
