/**
 * 模型路由控制台的浏览器半边（cordis 客户端插件）。
 *
 * 它只占一个位置：设置面板里的「模型路由」一节（`settings.section`）。
 * 为什么放在设置页而不是主面板或侧边栏：这是**管理员**的能力，
 * 普通用户看到它只会困惑——「千手·迅捷 由 flash 作答」不是用户该关心的事实。
 * 设置页本来就是「本机配置与运维」的地盘，管理面挂在这里不会污染日常界面。
 *
 * 依赖声明是唯一的服务入口：`slots` 注册位置，`locale` 提供文案字典。
 * 目录数据与追加入口的详情全部走 `./client/index.ts` 里的注入面。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// 类型侧拉入设置的 SlotMap 合并（`settings.section` 的声明）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { RouteConsoleController } from './controller.ts'
import { RoutingConsoleSection, type RoutingConsoleInjected } from './RoutingConsoleSection.tsx'
import { PluginReviewSection } from './PluginReviewSection.tsx'
import { NS, en, zh, type RoutingKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'qianshou.routing': RoutingKey
  }
}

/** 这一节在设置页导航里的位置：排在「模型」之后，「关于」之前。 */
const SECTION_ORDER = 20
/** 这一节的导航 id（`only` 过滤与深链用）。 */
const SECTION_ID = 'routing'

/** 需要的服务：槽位注册与文案字典。 */
export const inject = ['slots', 'locale']

/**
 * 注册字典并占住设置页的一节。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: Context): void {
  // 控制台会话按插件生命周期持有：设置面板可能被反复开合，
  // 而一次「追加绑定」的往返不能因为面板重挂载被丢掉。
  const controller = new RouteConsoleController()
  ctx.effect(() => () => { controller.dispose() }, 'ui-settings-routing: request lifetime')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-routing: dictionaries')

  const t = ctx.locale.bind(NS) as (key: RoutingKey, values?: Record<string, string>) => string
  const injected = (): RoutingConsoleInjected => ({
    controller,
    hooks: { catalog: controller.store },
    refresh: () => controller.refresh(),
    bind: request => controller.bind(request),
    t,
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: SECTION_ORDER,
    label: () => t('nav'),
    inject: injected,
  }, RoutingConsoleSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'plugin-review',
    order: SECTION_ORDER + 1,
    label: () => t('pluginReviewNav'),
    inject: () => ({ t }),
  }, PluginReviewSection))
}
