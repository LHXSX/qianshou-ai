/**
 * 页面视图的订阅钩子。
 *
 * 上游给插槽组件的 `inject` 面是**普通对象**，而 React 需要外部存储订阅
 * 才能在快照变化时重渲染。`useSyncExternalStore` 正好是这个形状的桥：
 * 它保证快照读取与订阅在同一个渲染里成对发生，不会出现"订阅晚一步、
 * 首帧显示旧值"的撕裂。抽成一个钩子是为了让卡片与页面用**同一份**订阅逻辑，
 * 而不是各写一遍、各错一遍。
 */

import { useSyncExternalStore } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AccountView } from './store.ts'

/** 订阅账户视图快照。 */
export function useAccountView(store: SnapshotStore<AccountView>): AccountView {
  return useSyncExternalStore(
    listener => store.subscribe(listener),
    () => store.getSnapshot(),
  )
}
