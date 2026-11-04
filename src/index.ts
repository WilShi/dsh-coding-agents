import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import { CODING_AGENTS_API_PREFIX, createCodingAgentsRoute } from './api-route.ts'
import { CodingAgentsManager } from './manager.ts'
import { createCodingAgentTools } from './tools.ts'

export * from './types.ts'
export { CodingAgentsManager } from './manager.ts'
export { createCodingAgentsRoute, CODING_AGENTS_API_PREFIX } from './api-route.ts'

export const name = 'dsh-coding-agents'
export const inject = ['webServer', 'subprocess', 'tools']

export async function apply(ctx: Context): Promise<void> {
  const manager = new CodingAgentsManager(ctx.subprocess, 4)
  ctx.effect(() => () => manager.dispose(), 'dsh-coding-agents: dispose manager')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CODING_AGENTS_API_PREFIX,
    handler: createCodingAgentsRoute(manager),
  }), 'dsh-coding-agents: HTTP API')
  ctx.effect(() => {
    const disposers = createCodingAgentTools(manager).map(tool => ctx.tools.register(tool))
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }, 'dsh-coding-agents: model tools')
}

export default { name, inject, apply }
