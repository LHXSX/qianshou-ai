/** Visible pending publication pages periodically read existing owner receipts. */
import { useEffect, useRef } from 'react'

const REVIEW_REFRESH_MS = 15_000

/** Schedule serial reads; changing callbacks never duplicates an in-flight read.
 * @param enabled - The page currently has an unapproved publication.
 * @param refresh - Existing account-checked read operation, never a submission.
 * @param busy - An existing page action or read is in progress.
 */
export function usePublicationReviewRefresh(enabled: boolean, refresh: (() => Promise<void>) | undefined,
  busy: boolean): void {
  const current = useRef({ refresh, busy })
  const reading = useRef(false)
  current.current = { refresh, busy }
  const available = refresh !== undefined
  useEffect(() => {
    if (!enabled || !available) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      if (active && document.visibilityState !== 'hidden') timer = setTimeout(() => { void read() }, REVIEW_REFRESH_MS)
    }
    const read = async (): Promise<void> => {
      timer = undefined
      if (!active || document.visibilityState === 'hidden') return
      if (!reading.current && !current.current.busy && current.current.refresh !== undefined) {
        reading.current = true
        try { await current.current.refresh() }
        catch (_error) { /* The existing controller owns stale/error presentation; future reads may recover. */ }
        finally { reading.current = false }
      }
      schedule()
    }
    const visibility = (): void => {
      clearTimeout(timer)
      timer = undefined
      if (document.visibilityState !== 'hidden' && !reading.current) schedule()
    }
    document.addEventListener('visibilitychange', visibility)
    schedule()
    return () => {
      active = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [enabled, available])
}
