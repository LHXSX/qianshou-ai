/** Capability reads as one settings section, installed only in Qianshou builds. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { CapabilityPanel, type CapabilityInjected } from './CapabilityPanel.tsx'
import { CapabilityController } from './controller.ts'
import { zh, en, type CapabilityKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'qianshou.capability': CapabilityKey } }

export const inject = ['slots', 'locale', 'remote',
  ...process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou' ? ['remote.qianshouCapability'] : [],
]

/**
 * Register the capability section; a reconnect re-reads the catalog because the Host may have signed in meanwhile.
 * @param ctx - Client context carrying the capability Remote.
 */
export function apply(ctx: Context): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'qianshou') return
  ctx.effect(() => ctx.locale.register('qianshou.capability', { zh, en }), 'qianshou-capability: locales')
  const controller = new CapabilityController(ctx)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'qianshou-capability', order: 6,
    label: () => ctx.locale.bind('qianshou.capability')('title'), locale: 'qianshou.capability',
    inject: (): CapabilityInjected => ({ controller, hooks: { capability: controller.store } }),
  }, CapabilityPanel))
  ctx.effect(() => ctx.on('connection/reset', () => { void controller.loadCatalog() }), 'qianshou-capability: reconnect')
}
