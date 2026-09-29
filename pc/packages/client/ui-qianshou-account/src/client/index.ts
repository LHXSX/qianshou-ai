/** Independent Qianshou account settings and sidebar entry, installed only in Qianshou builds. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
export type { QianshouAccountEvents } from './account-events.ts'
import { AccountController } from './controller.ts'
import { AccountPanel, AccountEntry, type AccountInjected } from './AccountPanel.tsx'
import { zh, en, type AccountKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'qianshou.account': AccountKey }
}

export const inject = ['slots', 'locale', 'remote',
  ...process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou' ? ['remote.qianshouAccount'] : [],
]

/** Register reversible account presentation without changing provider settings. */
export function apply(ctx: Context): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'qianshou') return
  ctx.effect(() => ctx.locale.register('qianshou.account', { zh, en }), 'qianshou-account: locales')
  const controller = new AccountController(ctx)
  const injected = (): AccountInjected => ({ controller, hooks: { account: controller.store } })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'qianshou-account', order: 5,
    label: () => ctx.locale.bind('qianshou.account')('personalCenter'), locale: 'qianshou.account', inject: injected,
  }, AccountPanel))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'qianshou-account', order: -10,
    locale: 'qianshou.account', inject: injected,
  }, AccountEntry))
  ctx.effect(() => ctx.on('connection/reset', () => { void controller.load() }), 'qianshou-account: reconnect')
}
