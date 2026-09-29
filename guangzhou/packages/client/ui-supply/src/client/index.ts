import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SupplyController } from './controller.ts'
import { SupplyPage, type SupplyFace } from './SupplyPage.tsx'
import { NS, en, forgeEn, forgeZh, zh, type SupplyKey } from './locales.ts'
import { SettingsSectionAdapter } from './settings-section.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'qianshou.supply': SupplyKey }
}

/** Runtime services used by the supply contribution. */
export const inject = ['slots', 'locale']

/**
 * Project one controller onto the slot face the page renders through.
 * @param controller - The plugin-lifetime supply controller.
 * @returns The face handed to the main slot registration.
 */
export function supplyFace(controller: SupplyController): SupplyFace {
  return {
    hooks: { supply: controller.store },
    refresh: () => controller.refresh(),
    savePolicy: policy => controller.savePolicy(policy),
  }
}

/** Install the local supply workspace with reversible navigation and route contributions.
 * @param ctx - Client plugin context carrying the slots and locale services.
 */
export function apply(ctx: Context): void {
  const controller = new SupplyController()
  ctx.effect(() => () => { controller.dispose() }, 'ui-supply: request lifetime')
  const dictionaries = process.env.DSH_CLIENT_BUILD_PROFILE === 'forge' ? { en: forgeEn, zh: forgeZh } : { en, zh }
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'ui-supply: dictionaries')
  const face = supplyFace(controller)
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: 'qianshou-supply', locale: NS, inject: () => face }, SupplyPage,
  ))
  /**
   * 这一页挂在**设置**里，不再占左栏内容导航。
   *
   * 理由（用户明确要求）：左栏应该只承载"对话 + 历史会话"；而算力、设备、
   * 记忆、供给这些属于"这台机器/这个账号的状态与配置"，设置才是它们的归属地。
   * `main` 注册保留——别处已有按 id 跳转的代码，删了会连带打断那些入口。
   */
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'qianshou-supply',
    order: process.env.DSH_CLIENT_BUILD_PROFILE === 'forge' ? 5 : 12,
    label: () => ctx.locale.bind(NS)('title'),
    locale: NS,
    inject: () => ({ face }),
  }, SettingsSectionAdapter))
}
