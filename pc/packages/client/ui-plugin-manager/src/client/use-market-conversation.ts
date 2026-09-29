/** One cancellable card selection; the existing conversation owns parameters, quotes and dispatch. */
import { useEffect, useRef, useState } from 'react'
import type { EnterMarketConversation, MarketConversationRequest } from './market-conversation-entry.ts'

export function useMarketConversation(enter: EnterMarketConversation | undefined) {
  const operation = useRef<AbortController | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => () => { operation.current?.abort(); operation.current = null }, [enter])
  const select = (request: MarketConversationRequest): void => {
    if (enter === undefined) return
    operation.current?.abort()
    const abort = new AbortController()
    operation.current = abort
    setPending(request.taskType); setFailed(null)
    const current = (): boolean => operation.current === abort
    const timer = setTimeout(() => {
      if (!current()) return
      abort.abort(); operation.current = null; setPending(null); setFailed(request.taskType)
    }, 15_000)
    void Promise.resolve().then(() => enter(request, abort.signal)).then((ok) => {
      if (current()) setFailed(ok ? null : request.taskType)
    }, () => { if (current()) setFailed(request.taskType) }).finally(() => {
      clearTimeout(timer)
      if (current()) { operation.current = null; setPending(null) }
    })
  }
  return { pending, failed, select }
}
