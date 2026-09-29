import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { MemoryController } from './controller.ts'
import { MemoryPage, type MemoryFace } from './MemoryPage.tsx'
import { NS, en, forgeEn, forgeZh, zh, type MemoryKey } from './locales.ts'
import { SettingsSectionAdapter } from './settings-section.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'qianshou.memory': MemoryKey }
}
/** Required Cordis services. */
export const inject = ['slots', 'locale']
/** Register an account-local memory workspace without adding model tools. */
export function apply(ctx: Context): void {
  const controller = new MemoryController()
  ctx.effect(() => () => { controller.dispose() }, 'ui-memory: request lifetime')
  const dictionaries = process.env.DSH_CLIENT_BUILD_PROFILE === 'forge' ? { en: forgeEn, zh: forgeZh } : { en, zh }
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'ui-memory: dictionaries')
  const face: MemoryFace = {
    hooks: { memory: controller.store }, refresh: () => controller.refresh(),
    filter: (change) => { controller.filter(change) }, select: id => controller.select(id),
    mutate: (action, body) => controller.mutate(action, body), exportData: () => controller.exportData(),
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'qianshou-memory', locale: NS, inject: () => face }, MemoryPage))
  /**
   * 这一页挂在**设置**里，不再占左栏内容导航。
   *
   * 理由（用户明确要求）：左栏应该只承载"对话 + 历史会话"；而算力、设备、
   * 记忆、供给这些属于"这台机器/这个账号的状态与配置"，设置才是它们的归属地。
   * `main` 注册保留——别处已有按 id 跳转的代码，删了会连带打断那些入口。
   */
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'qianshou-memory',
    order: process.env.DSH_CLIENT_BUILD_PROFILE === 'forge' ? 6 : 12,
    label: () => ctx.locale.bind(NS)('title'),
    locale: NS,
    inject: () => ({ face }),
  }, SettingsSectionAdapter))
}
