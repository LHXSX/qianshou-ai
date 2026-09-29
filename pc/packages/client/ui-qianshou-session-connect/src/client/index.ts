/** Explicit per-Session owner authorization UI, installed only in Qianshou builds. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ConnectEntry, type ConnectInjected } from './ConnectEntry.tsx'
import { zh, en, type ConnectKey } from './locales.ts'
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'qianshou.sessionConnect': ConnectKey } }
export const inject = ['slots', 'locale', 'remote',
  ...process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou' ? ['remote.qianshouSessionConnect'] : [],
]
function unwrap<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error('Session connection operation failed')
  return result.value
}
/**
 * Register local-owner grants without introducing cloud-account ownership.
 * @param ctx - Client context with the authenticated owner Remote.
 */
export function apply(ctx: Context): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'qianshou') return
  ctx.effect(() => ctx.locale.register('qianshou.sessionConnect', { zh, en }), 'qianshou-session-connect: locales')
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'qianshou-session-connect', order: 35, locale: 'qianshou.sessionConnect',
    inject: (): ConnectInjected => ({
      state: async id => unwrap(await ctx.remote.qianshouSessionConnect.state(id)),
      create: async input => unwrap(await ctx.remote.qianshouSessionConnect.create(input)),
      revoke: async (id, grantId) => { unwrap(await ctx.remote.qianshouSessionConnect.revoke(id, grantId)) },
    }),
  }, ConnectEntry))
}
