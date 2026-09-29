/** Qianshou-only local knowledge page composed through existing main/sidebar slots. */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { MemoryController } from './controller.ts'
import { MemoryPage, MemoryIcon, type MemoryInjected } from './MemoryPage.tsx'
import { zh, en, type MemoryKey } from './locales.ts'
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'qianshou.memory': MemoryKey } }
export const inject = ['slots', 'locale', 'remote',
  ...process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou' ? ['remote.qianshouMemory'] : [],
]
/**
 * Register one independent page without coupling local ownership to cloud identity.
 * @param ctx - Injected Client context.
 */
export function apply(ctx: Context): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'qianshou') return
  ctx.effect(() => ctx.locale.register('qianshou.memory', { zh, en }), 'qianshou-memory: locales')
  const controller = new MemoryController(ctx)
  const panel = 'qianshou-memory' as MainPanelId
  ctx.effect(() => () =>{  controller.dispose() }, 'qianshou-memory: controller')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panel, locale: 'qianshou.memory', inject: (): MemoryInjected => ({ controller, hooks: { memory: controller.store } }) }, MemoryPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panel, order: 10, locale: 'qianshou.memory', label: () => ctx.locale.bind('qianshou.memory')('title') }, MemoryIcon))
  ctx.on('connection/reset', () =>{  controller.reconnect() })
}
