/** Build-selected DeepSeek and Qianshou occupants for browser-brand slots. */
import { createElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { OfficialBrandMark, OfficialBrandName } from './Brand.tsx'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ForgeBrandMark, ForgeBrandName } from './ForgeBrand.tsx'
import { DestinationPage, type DestinationId, type DestinationOccupantProps } from './DestinationPage.tsx'
import { PRODUCT_DESTINATIONS } from './destinations.ts'
import { createDestinationInjected } from './destination-state.ts'
import { ProductRail, type ProductRailInjected } from './ProductRail.tsx'
import { en, zh, type ForgeBrandKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'forge.brand': ForgeBrandKey }
}

/** Required service: the UI slot registry. */
export const inject = ['slots']

/** One product destination row from the shared product-nav catalogue. */
type ProductDestinationEntry = (typeof PRODUCT_DESTINATIONS)[number]

/**
 * Build the occupant component for one product destination.
 *
 * The occupant takes exactly the framework share (standard seats + this
 * registration's injected face) and overlays the catalogue row's identity, so
 * the identity lives in one place while the registration keeps full checking
 * against `DestinationOccupantProps`.
 * @param destination - the catalogue row this occupant renders.
 * @returns the slot component for that destination.
 */
function ProductDestination(destination: ProductDestinationEntry) {
  return function ProductDestinationPage(props: DestinationOccupantProps) {
    return createElement(DestinationPage, {
      ...props,
      id: destination.id as DestinationId,
      title: destination.title,
      body: destination.body,
    })
  }
}

/**
 * Fill the sidebar brand slots as one declaration-aware registration set.
 * The private build also shares its mark with the independent hero slot,
 * occupies the right-rail guide, and registers honest product destinations.
 * The official build retains the hero's declaring fallback.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE === 'forge') {
    ctx.inject(['locale'], (ctx) => {
      ctx.effect(() => ctx.locale.register('forge.brand', { zh, en }), 'forge: brand copy')
      // Built once for the whole plugin lifetime: the destination pages read one
      // stable observable, so a render can never re-create the sources.
      const destinationInjected = createDestinationInjected(ctx as unknown as ClientContext)
      ctx.slots.inject('sidebar.brand.mark', () =>
        ctx.slots.inject('sidebar.brand.name', function* () {
          yield ctx.slots.register({ name: 'sidebar.brand.mark' }, ForgeBrandMark)
          yield ctx.slots.register({ name: 'sidebar.brand.name', locale: 'forge.brand' }, ForgeBrandName)
        }))
      ctx.slots.inject('conversation.hero.brand.mark', () =>
        ctx.slots.register({ name: 'conversation.hero.brand.mark' }, ForgeBrandMark))
      /**
       * 四个产品页**挂在设置里，不进左栏内容导航**。
       *
       * 为什么（用户明确要求的一件事）：左栏应该是"对话 + 历史会话"，
       * 而内容型入口（智能体广场 / 工作流 / 文件与数据 / 模型与API）
       * 属于"配置与运维"的位置——设置本来就是这些事实的归属地。
       * 早先把它们做成左栏图标按钮，结果是左栏被九行导航占满、
       * 与"这是聊天工具"的第一眼印象相互打架。
       *
       * 迁移做法保留 `main` 注册：别处已有按 id 跳转的代码
       * （`layout.selectPanel('qianshou-agents')` 之类），删了会把那些入口一起打断；
       * 左栏的图标注册才是这次要移除的部分。
       */
      for (const destination of PRODUCT_DESTINATIONS) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: destination.id,
          locale: 'forge.brand',
          // One face per plugin load: the live observable must keep its identity
          // across renders, or every re-render would restart the page's effects.
          inject: () => destinationInjected,
        }, ProductDestination(destination)))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: destination.id,
          // 设置里的次序：沿用目的地原有 order，保证四页相对顺序不变。
          order: destination.order,
          label: () => ctx.locale.bind('forge.brand')(destination.title),
          locale: 'forge.brand',
          inject: () => destinationInjected,
        }, ProductDestination(destination)))
      }
      ctx.slots.inject('sidebar.right.tab.guide', () => ctx.slots.register({
        name: 'sidebar.right.tab.guide',
        select: () => true,
        locale: 'forge.brand',
        inject: (sessionId: SessionId): ProductRailInjected => {
          const layoutOf = () => ctx.reflect.get('layout', false) as ClientContext['layout'] | undefined
          const openChat = () => { layoutOf()?.selectPanel(null) }
          const openModels = () => { layoutOf()?.selectPanel('qianshou-models-api' as MainPanelId) }
          const openTasks = () => { layoutOf()?.selectPanel('qianshou-compute' as MainPanelId) }
          const models = ctx.reflect.get('modelDirectories', false) as ClientContext['modelDirectories'] | undefined
          const sessions = ctx.reflect.get('sessions', false) as ClientContext['sessions'] | undefined
          if (models === undefined || sessions === undefined || sessionId === undefined) {
            return { directory: null, load: () => {}, openChat, openModels, openTasks, selectModel: () => {} }
          }
          const available = sessions.subagentAddress(sessionId) === undefined
          const directory = models.directoryFor(sessionId)
          return {
            directory: directory.store,
            load: () => {
              if (available) directory.load().catch(() => { /* surfaced on the store */ })
            },
            openChat,
            openModels,
            openTasks,
            selectModel: (provider, model) => {
              if (!available) return
              directory.select({ provider, model }).catch(() => { /* surfaced on the store */ })
            },
          }
        },
      }, ProductRail))
    })
    return
  }
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, OfficialBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, OfficialBrandName)
    }))
}
