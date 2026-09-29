/** Prevent account/entitlement snapshots or late reads from surviving an administrator identity change. */
import { onBeforeUnmount, ref, watch } from 'vue'
import { session } from '@/session/store'
import type { AsyncState } from './async-state'
export function useAccountData<T>(loader: () => Promise<T>): AsyncState<T> {
  const data = ref<T>()
  const error = ref<Error>(); const loading = ref(false); const loaded = ref(false)
  let generation = 0
  const clear = () => { generation++; data.value = undefined; error.value = undefined; loading.value = false; loaded.value = false }
  watch(() => session.admin?.accountId, clear, { flush: 'sync' })
  onBeforeUnmount(clear)
  const run = async () => {
    if (!session.admin) { clear(); return }
    const request = ++generation; loading.value = true; error.value = undefined; data.value = undefined
    try { const result = await loader(); if (request === generation) { data.value = result; loaded.value = true } }
    catch (cause) { if (request === generation) { error.value = cause instanceof Error ? cause : new Error('读取失败'); loaded.value = true } }
    finally { if (request === generation) loading.value = false }
  }
  return { data, error, loading, loaded, run }
}
