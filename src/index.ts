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

/** Structural view of the host workspace registry (`ctx.workspaceRegistry`). */
interface WorkspaceRegistryLike {
  list(): readonly { readonly path?: string }[]
}

/**
 * Registered workspace roots, or `undefined` when this composition exposes no
 * workspace registry. Read per request: the HTTP surface refuses every `cwd`
 * it cannot prove is inside one of these roots.
 * @param ctx - host context.
 * @returns absolute workspace roots, or undefined without a registry.
 */
function registeredWorkspaceRoots(ctx: Context): string[] | undefined {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
  if (registry === undefined) return undefined
  try {
    return registry.list()
      .map(workspace => workspace.path)
      .filter((path): path is string => typeof path === 'string' && path !== '')
  } catch {
    return undefined
  }
}

export async function apply(ctx: Context): Promise<void> {
  const manager = new CodingAgentsManager(ctx.subprocess, 4)
  ctx.effect(() => () => manager.dispose(), 'dsh-coding-agents: dispose manager')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CODING_AGENTS_API_PREFIX,
    handler: createCodingAgentsRoute(manager, { workspaceRoots: () => registeredWorkspaceRoots(ctx) }),
  }), 'dsh-coding-agents: HTTP API')
  ctx.effect(() => {
    const disposers = createCodingAgentTools(manager).map(tool => ctx.tools.register(tool))
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }, 'dsh-coding-agents: model tools')
}

export default { name, inject, apply }
