/**
 * 个人中心的**主面板座位**：只做透传。
 *
 * 内容与状态都在 `AccountTabs` 里（含用量读取）。这里存在的原因只有一个：
 * 同一个内容要在两个座位里渲染，而两个座位的 props 形状不同——
 * 主面板给 `layout.selectPanel`，设置给 `close`。所以包装层只负责
 * "把这个座位的 back 语义翻译成正确动作"，不留任何自己的状态。
 *
 * 上一版它自己读用量再透传下去；那样设置座位就拿不到同一份 hook，
 * 只能复制实现或把状态提到插件层（多一份可能不一致的真相）。
 */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AccountTabs } from './AccountTabs.tsx'
import type { AccountView } from './store.ts'
import type { TranslateAccount } from './locales.ts'

/** 主面板座位的注入面。 */
export interface AccountCenterInjected {
  readonly view: SnapshotStore<AccountView>
  readonly refresh: () => void
  readonly forceRefresh: () => void
  /** 回到对话。 */
  readonly back: () => void
}

/** 主面板座位的完整入参。 */
export type AccountCenterProps = PropsRuntime<'main'> & AccountCenterInjected & { readonly t: TranslateAccount }

/** 个人中心主面板。 */
export function AccountCenter({ view, refresh, forceRefresh, back, t }: AccountCenterProps) {
  return (
    <AccountTabs
      view={view}
      refresh={refresh}
      forceRefresh={forceRefresh}
      back={back}
      readAt={view.getSnapshot().readAt}
      t={t}
    />
  )
}
