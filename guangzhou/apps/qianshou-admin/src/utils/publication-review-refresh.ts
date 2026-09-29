/** Account-bound, serial read-only refresh for pending publication evidence. */
import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { listOrderPublications, type MarketplaceReviewQueue, type OrderPublicationReviewItem } from '@/api/modules/marketplace'

const REVIEW_REFRESH_MS = 15_000

export function usePublicationReviewRefresh(input: {
  owner: () => string | undefined
  canRead: () => boolean
  paused: () => boolean
}) {
  const data = shallowRef<MarketplaceReviewQueue<OrderPublicationReviewItem>>()
  const error = shallowRef<Error>()
  const loading = ref(false)
  const loaded = ref(false)
  let mounted = false
  let generation = 0
  let reading: Promise<void> | undefined
  let reread = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const available = (): boolean => mounted && input.owner() !== undefined && input.canRead()
  const clearTimer = (): void => { clearTimeout(timer); timer = undefined }
  const schedule = (): void => {
    clearTimer()
    if (!available() || document.visibilityState === 'hidden'
      || !data.value?.items.some(item => item.status === 'review')) return
    timer = setTimeout(() => {
      timer = undefined
      if (document.visibilityState === 'hidden') return
      if (input.paused()) schedule()
      else void run()
    }, REVIEW_REFRESH_MS)
  }
  const run = (): Promise<void> => {
    if (!available()) return Promise.resolve()
    if (reading !== undefined) return reading
    clearTimer()
    const owner = input.owner()
    const requestedGeneration = generation
    loading.value = true
    error.value = undefined
    const current = (): boolean => available() && generation === requestedGeneration && input.owner() === owner
    reading = (async () => {
      try {
        const queue = await listOrderPublications()
        if (current()) { data.value = queue; loaded.value = true }
      } catch (caught) {
        if (current()) { error.value = caught instanceof Error ? caught : new Error('投稿状态读取失败'); loaded.value = true }
      } finally {
        reading = undefined
        if (current()) loading.value = false
        if (reread && available()) { reread = false; void run() }
        else schedule()
      }
    })()
    return reading
  }
  watch(() => [input.owner(), input.canRead()] as const, () => {
    generation += 1
    clearTimer()
    data.value = undefined; error.value = undefined; loaded.value = false; loading.value = false
    reread = available() && reading !== undefined
    if (available() && reading === undefined) void run()
  }, { flush: 'sync' })
  const visibility = (): void => { clearTimer(); if (document.visibilityState !== 'hidden') schedule() }
  onMounted(() => {
    mounted = true
    document.addEventListener('visibilitychange', visibility)
    if (available()) void run()
  })
  onUnmounted(() => {
    mounted = false; generation += 1; reread = false
    clearTimer()
    document.removeEventListener('visibilitychange', visibility)
  })
  return { data, error, loading, loaded, run }
}
