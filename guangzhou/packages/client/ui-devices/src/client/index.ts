import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DevicesController } from './controller.ts'
import { RelayController, type RelayBridge } from './relay-controller.ts'
import { DevicesPage, type DevicesFace } from './DevicesPage.tsx'
import { NS, zh, en, type DevicesKey } from './locales.ts'
import { SettingsSectionAdapter } from './settings-section.tsx'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'qianshou.devices': DevicesKey
  }
}
export const inject = ['slots', 'locale']
/** Install one coordinator controller and its sidebar/main panel seats. */
export function apply(ctx: Context): void {
  const controller = new DevicesController()
  const relay = new RelayController((window as unknown as { qianshouDesktop?: { relay?: RelayBridge } }).qianshouDesktop?.relay)
  ctx.effect(() => () =>{  relay.dispose() }, 'ui-devices: relay view lifetime')
  ctx.effect(() => () =>{  controller.dispose() }, 'ui-devices: request lifetime')
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    'ui-devices: dictionaries',
  )
  const face: DevicesFace = {
    hooks: { devices: controller.store, relay: relay.store },
    attach: () => { const devices = controller.attach(), status = relay.attach(); return () => { devices(); status() } },
    relayAct: action => relay.act(action),
    refresh: () => controller.refresh(),
    loadReleases: () => controller.loadReleases(),
    act: (path, body) => controller.act(path, body),
  }
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: 'qianshou-devices', locale: NS, inject: () => face },
      DevicesPage,
    ),
  )
  /**
   * 这一页挂在**设置**里，不再占左栏内容导航。
   *
   * 理由（用户明确要求）：左栏应该只承载"对话 + 历史会话"；而算力、设备、
   * 记忆、供给这些属于"这台机器/这个账号的状态与配置"，设置才是它们的归属地。
   * `main` 注册保留——别处已有按 id 跳转的代码，删了会连带打断那些入口。
   */
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'qianshou-devices',
    order: 10,
    label: () => ctx.locale.bind(NS)('title'),
    locale: NS,
    inject: () => ({ face }),
  }, SettingsSectionAdapter))
}
