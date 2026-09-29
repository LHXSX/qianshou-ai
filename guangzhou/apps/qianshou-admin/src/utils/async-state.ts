/**
 * 页面级异步取数的小工具。
 *
 * 各页面都用同一套「加载中 / 成功 / 失败」状态机，
 * 避免每个视图重复写 try/catch 导致错误分类在个别页面走样。
 */

import { ref, type Ref } from 'vue'

export interface AsyncState<T> {
  readonly data: Ref<T | undefined>
  readonly error: Ref<Error | undefined>
  readonly loading: Ref<boolean>
  readonly loaded: Ref<boolean>
  /** 执行一次取数；失败时把错误存进 `error`（不抛出），由视图决定如何渲染。 */
  run: () => Promise<void>
}

export function useAsyncData<T>(loader: () => Promise<T>): AsyncState<T> {
  const data = ref<T | undefined>(undefined) as Ref<T | undefined>
  const error = ref<Error | undefined>(undefined)
  const loading = ref(false)
  const loaded = ref(false)

  const run = async (): Promise<void> => {
    loading.value = true
    error.value = undefined
    try {
      data.value = await loader()
      loaded.value = true
    } catch (caught) {
      error.value = caught instanceof Error ? caught : new Error(String(caught))
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  return { data, error, loading, loaded, run }
}
