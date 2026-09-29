// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { UiConversation } from '../src/client/conversation/assembly.ts'

const SID = SessionId('activity-session')
async function bench() {
  const runtime = await SlotTestRuntime.create()
  await runtime.sessions.add({ id: SID, snapshot: { blank: true, awaitingFirstTurn: true } })
  const reference = runtime.sessions.retain(SID)
  await reference.ready
  const service = new UiConversation(runtime.ctx, runtime.sessions)
  return { runtime, reference, service, binding: service.binding(SID) }
}

function activity(initial = false) {
  let visible = initial
  let notify = () => {}
  const stop = vi.fn()
  const source: ObservableSnapshot<boolean> = {
    getSnapshot: () => visible,
    subscribe: (listener) => { notify = listener; return stop },
  }
  return { source, stop, update(value: boolean) { visible = value; notify() }, late: () => { notify() } }
}

describe('exact-binding Conversation presentation activity', () => {
  it('combines independent observers and removes only the withdrawing activity', async () => {
    const b = await bench()
    try {
      const one = activity(true)
      const two = activity(true)
      const offOne = b.binding.observeActivity('chat', one.source)
      const offTwo = b.binding.observeActivity('chat', two.source)
      expect([...b.binding.snapshot.getSnapshot().activeTargets]).toEqual(['chat'])
      offOne(); offOne()
      expect([...b.binding.snapshot.getSnapshot().activeTargets]).toEqual(['chat'])
      offTwo()
      expect(b.binding.snapshot.getSnapshot().activeTargets.size).toBe(0)
      one.late(); two.late()
      expect(b.binding.snapshot.getSnapshot().activeTargets.size).toBe(0)
      expect(one.stop).toHaveBeenCalledTimes(1)
      expect(two.stop).toHaveBeenCalledTimes(1)
      expect(b.runtime.sessions.binding(SID)?.eventSource.getSnapshot().entries).toEqual([])
    } finally { await b.runtime.dispose() }
  })

  it('rereads after subscription and contains throwing unsubscribe and late callbacks', async () => {
    const b = await bench()
    try {
      let visible = true
      let notify = () => {}
      const stop = vi.fn(() => { notify(); throw new Error('provider cleanup failed') })
      const remove = b.binding.observeActivity('chat', {
        getSnapshot: () => visible,
        subscribe: (listener) => { notify = listener; visible = false; return stop },
      })
      expect(b.binding.snapshot.getSnapshot().activeTargets.size).toBe(0)
      visible = true; notify()
      expect(b.binding.snapshot.getSnapshot().activeTargets.has('chat')).toBe(true)
      expect(remove).not.toThrow()
      notify()
      expect(b.binding.snapshot.getSnapshot().activeTargets.size).toBe(0)
      expect(stop).toHaveBeenCalledTimes(1)
    } finally { await b.runtime.dispose() }
  })

  it('withdraws a failed subscription without dropping another observer', async () => {
    const b = await bench()
    try {
      const kept = activity(true)
      b.binding.observeActivity('chat', kept.source)
      expect(() => b.binding.observeActivity('chat', {
        getSnapshot: () => true, subscribe: () => { throw new Error('subscription failed') },
      })).toThrow('subscription failed')
      expect(b.binding.snapshot.getSnapshot().activeTargets.has('chat')).toBe(true)
      kept.update(false)
      expect(b.binding.snapshot.getSnapshot().activeTargets.size).toBe(0)
    } finally { await b.runtime.dispose() }
  })

  it('does not republish an activity withdrawn synchronously while reading its update', async () => {
    const b = await bench()
    try {
      let remove = () => {}
      let withdrawDuringRead = false
      let notify = () => {}
      const stop = vi.fn()
      remove = b.binding.observeActivity('chat', {
        getSnapshot: () => { if (withdrawDuringRead) remove(); return true },
        subscribe: (listener) => { notify = listener; return stop },
      })
      withdrawDuringRead = true
      notify()
      expect(b.binding.snapshot.getSnapshot().activeTargets.size).toBe(0)
      expect(stop).toHaveBeenCalledTimes(1)
    } finally { await b.runtime.dispose() }
  })

  it('cleans a subscription that returns after synchronous binding disposal', async () => {
    const b = await bench()
    try {
      const stop = vi.fn()
      b.binding.observeActivity('chat', {
        getSnapshot: () => true,
        subscribe: () => { b.reference.release(); return stop },
      })
      await vi.waitFor(() => { expect(stop).toHaveBeenCalledTimes(1) })
      expect(b.binding.snapshot.getSnapshot().activeTargets.size).toBe(0)
    } finally { await b.runtime.dispose() }
  })

  it('silences released generation callbacks and never promotes the same-id replacement binding', async () => {
    const b = await bench()
    try {
      const old = activity(true)
      b.binding.observeActivity('chat', old.source)
      b.reference.release()
      await vi.waitFor(() => { expect(old.stop).toHaveBeenCalledTimes(1) })
      const next = b.runtime.sessions.retain(SID)
      await next.ready
      const replacement = b.service.binding(SID)
      expect(replacement).not.toBe(b.binding)
      old.late()
      expect(replacement.snapshot.getSnapshot().activeTargets.size).toBe(0)
      expect(b.binding.snapshot.getSnapshot().activeTargets.size).toBe(0)
      const inactive = activity(true)
      b.binding.observeActivity('chat', inactive.source)
      expect(inactive.stop).not.toHaveBeenCalled()
      expect(replacement.snapshot.getSnapshot().activeTargets.size).toBe(0)
      expect(b.runtime.sessions.binding(SID)?.eventSource.getSnapshot().entries).toEqual([])
      next.release()
    } finally { await b.runtime.dispose() }
  })
})
