/** In-memory storage and PC responses are fixtures; they establish no account or device connection. */
import { vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { PcWindowController } from '../src/controller.ts'
import type { PcWindowBootstrap } from '../src/types.ts'
import type { PcWindowPort, WindowBinding, WindowCommand, WindowJournal, WindowJournalStore, WindowReceipt } from '../src/types.ts'
import { originKey } from '../src/validation.ts'

export const binding: WindowBinding = { accountId: 'owner', pcId: 'pc-a', sessionId: 'conversation-a' as SessionId, sourceDeviceId: 'phone-a' }
export const otherBinding: WindowBinding = { ...binding, accountId: 'another-owner', sessionId: 'conversation-b' as SessionId }

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export function receipt(command: WindowCommand, overrides: Partial<WindowReceipt> = {}): WindowReceipt {
  return { requestId: command.requestId, origin: command.origin, revision: 1, state: 'received',
    ...(command.action.type === 'dispatch' ? { childSessionId: `child-${command.requestId}` as SessionId } : {}), reason: null, ...overrides }
}

export function setup() {
  let now = 1000
  let id = 0
  const rows = new Map<string, WindowJournal>()
  const store: WindowJournalStore = {
    load: vi.fn<WindowJournalStore['load']>(async origin => structuredClone(rows.get(originKey(origin)) ?? null)),
    save: vi.fn<WindowJournalStore['save']>(async (journal, expected) => {
      if ((rows.get(originKey(journal.binding))?.revision ?? 0) !== expected) throw new Error('PC_WINDOW_STALE_LOCAL_REVISION')
      rows.set(originKey(journal.binding), structuredClone(journal))
    }),
    remove: vi.fn<WindowJournalStore['remove']>(async (origin) => { rows.delete(originKey(origin)) }),
  }
  const port: PcWindowPort = {
    // 引导返回的绑定由夹具决定：手机不能自己编造账号/PC/会话，测试也不该假装它能。
    bootstrap: vi.fn<PcWindowPort['bootstrap']>(
      async (deviceId: string, _signal: AbortSignal, sessionId?: string): Promise<PcWindowBootstrap> => ({
        binding: {
          accountId: 'acct', pcId: 'pc',
          sessionId: (sessionId ?? 'session-primary') as WindowBinding['sessionId'],
          sourceDeviceId: deviceId,
        },
        access: { state: 'online', allowedActions: ['dispatch', 'append', 'cancel'] },
      }),
    ),
    access: vi.fn<PcWindowPort['access']>(async () => ({ state: 'online', allowedActions: ['dispatch', 'append', 'cancel'] })),
    submit: vi.fn<PcWindowPort['submit']>(async command => receipt(command)),
    sync: vi.fn<PcWindowPort['sync']>(async (origin, cursor) => ({ binding: origin, fromCursor: cursor, nextCursor: `cursor-${now}`, receipts: [], notReceivedIds: [] })),
  }
  const create = () => new PcWindowController({ store, port, requestId: () => `request-${++id}` as SessionRequestId, now: () => now })
  return { store, rows, port, create, setNow(value: number) { now = value }, controller: create() }
}
