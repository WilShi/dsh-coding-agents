import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createCodingAgentsApi } from './api.ts'
import { CodingAgentsView } from './CodingAgentsView.tsx'

export const name = 'dsh-coding-agents'
export const inject = ['slots']

export function apply(ctx: Context): void {
  const api = createCodingAgentsApi()
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'coding-agents',
    order: 46,
    label: () => '编程助手',
    inject: () => ({ api }),
  }, CodingAgentsView))
}

export default { name, inject, apply }
