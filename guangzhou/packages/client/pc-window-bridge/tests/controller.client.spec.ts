import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WindowCommand, WindowJournal, WindowReceipt } from '../src/types.ts'
import { originKey } from '../src/validation.ts'
import { binding, deferred, otherBinding, receipt, setup } from './fixtures.client.ts'

describe('phone PC-window delivery', () => {
  it('persists offline input and permits withdrawing only unsent commands', async () => {
    const test = setup()
    vi.mocked(test.port.access).mockResolvedValue({ state: 'offline', allowedActions: ['dispatch'] })
    await test.controller.connect(binding)
    const id = await test.controller.enqueue({ type: 'dispatch', text: 'Write an article' }, 5000)
    expect(test.controller.snapshot().records[0]?.state).toBe('queued')
    expect(test.rows.get(originKey(binding))?.records[0]?.command.requestId).toBe(id)
    expect(test.port.submit).not.toHaveBeenCalled()
    await test.controller.withdraw(id)
    await test.controller.flush()
    expect(test.controller.snapshot().records[0]?.state).toBe('withdrawn')
    expect(test.port.submit).not.toHaveBeenCalled()
  })

  it('stores before sending and admits independent commands without waiting for the first task', async () => {
    const test = setup()
    const first = deferred<WindowReceipt>()
    vi.mocked(test.port.submit).mockImplementationOnce(async (command) => {
      expect(test.rows.get(originKey(binding))?.records[0]?.state).toBe('delivering')
      expect(command.origin).toEqual(binding)
      return first.promise
    })
    await test.controller.connect(binding)
    const a = await test.controller.enqueue({ type: 'dispatch', text: 'Long independent task' }, 5000)
    await vi.waitFor(() =>{  expect(test.port.submit).toHaveBeenCalledTimes(1) })
    await test.controller.enqueue({ type: 'dispatch', text: 'Another independent task' }, 5000)
    await vi.waitFor(() =>{  expect(test.controller.snapshot().records[1]?.state).toBe('received') })
    expect(test.controller.snapshot().records[0]?.state).toBe('delivering')
    const command = test.controller.snapshot().records[0]!.command
    first.resolve(receipt(command))
    await vi.waitFor(() =>{  expect(test.controller.snapshot().records[0]?.state).toBe('received') })
    await expect(test.controller.withdraw(a)).rejects.toThrow('MAY_HAVE_BEEN_RECEIVED')
  })

  it('keeps ambiguous admission uncertain through restart and does not blindly replay it', async () => {
    const test = setup()
    vi.mocked(test.port.submit).mockRejectedValue(new Error('Network response lost'))
    await test.controller.connect(binding)
    await test.controller.enqueue({ type: 'dispatch', text: 'Task' }, 5000)
    await vi.waitFor(() =>{  expect(test.controller.snapshot().records[0]?.state).toBe('uncertain') })
    const restored = test.create()
    await restored.connect(binding)
    await restored.refresh()
    expect(restored.snapshot().records[0]?.state).toBe('uncertain')
    expect(test.port.submit).toHaveBeenCalledTimes(1)
    vi.mocked(test.port.sync).mockImplementation(async (origin, cursor) => ({ binding: origin, fromCursor: cursor, nextCursor: 'confirmed', receipts: [receipt(restored.snapshot().records[0]!.command)], notReceivedIds: [] }))
    await restored.refresh()
    expect(restored.snapshot().records[0]?.state).toBe('received')
    expect(test.port.submit).toHaveBeenCalledTimes(1)
  })

  it('retries only an explicitly non-admitted command using its original request identity', async () => {
    const test = setup()
    vi.mocked(test.port.submit).mockRejectedValueOnce(new Error('Lost reply'))
    await test.controller.connect(binding)
    const id = await test.controller.enqueue({ type: 'dispatch', text: 'Task' }, 5000)
    await vi.waitFor(() =>{  expect(test.controller.snapshot().records[0]?.state).toBe('uncertain') })
    vi.mocked(test.port.sync).mockImplementation(async (origin, cursor) => ({ binding: origin, fromCursor: cursor, nextCursor: 'proof', receipts: [], notReceivedIds: [id] }))
    await test.controller.refresh()
    expect(test.controller.snapshot().records[0]?.state).toBe('received')
    expect(vi.mocked(test.port.submit).mock.calls.map(([command]) => command.requestId)).toEqual([id, id])
  })

  it('expires queued work without sending; an uncertain expired command still needs a receipt', async () => {
    const test = setup()
    vi.mocked(test.port.access).mockResolvedValue({ state: 'offline', allowedActions: ['dispatch'] })
    await test.controller.connect(binding)
    await test.controller.enqueue({ type: 'dispatch', text: 'Task' }, 2000)
    test.setNow(3000)
    vi.mocked(test.port.access).mockResolvedValue({ state: 'online', allowedActions: ['dispatch'] })
    await test.controller.flush()
    expect(test.controller.snapshot().records[0]?.state).toBe('expired')
    expect(test.port.submit).not.toHaveBeenCalled()
  })

  it('does not call an uncertain expired admission cancelled or safe to resubmit', async () => {
    const test = setup()
    vi.mocked(test.port.submit).mockRejectedValue(new Error('Reply lost'))
    await test.controller.connect(binding)
    await test.controller.enqueue({ type: 'dispatch', text: 'Task' }, 2000)
    await vi.waitFor(() => { expect(test.controller.snapshot().records[0]?.state).toBe('uncertain') })
    test.setNow(3000)
    await test.controller.refresh()
    expect(test.controller.snapshot().records[0]?.state).toBe('uncertain')
    expect(test.port.submit).toHaveBeenCalledTimes(1)
  })

  it('rejects a stale or cross-conversation sync cursor without committing its observations', async () => {
    const test = setup()
    await test.controller.connect(binding)
    vi.mocked(test.port.sync).mockResolvedValue({ binding, fromCursor: 'not-the-current-cursor', nextCursor: 'bad', receipts: [], notReceivedIds: [] })
    await expect(test.controller.refresh()).rejects.toThrow('SYNC_ORIGIN_MISMATCH')
    expect(test.controller.snapshot().cursor).toBeNull()
    expect(test.controller.snapshot().records).toEqual([])
  })

  it('waits for a previous origin write to settle before restoring that same origin', async () => {
    const test = setup()
    vi.mocked(test.port.access).mockResolvedValue({ state: 'offline', allowedActions: ['dispatch'] })
    await test.controller.connect(binding)
    const write = deferred<undefined>()
    vi.mocked(test.store.save).mockImplementationOnce(async (journal, expected) => {
      await write.promise
      if ((test.rows.get(originKey(journal.binding))?.revision ?? 0) !== expected) throw new Error('STALE')
      test.rows.set(originKey(journal.binding), structuredClone(journal))
    })
    const saving = test.controller.enqueue({ type: 'dispatch', text: 'Task' }, 5000)
    await vi.waitFor(() => { expect(test.store.save).toHaveBeenCalled() })
    const reconnect = test.controller.connect(binding)
    await Promise.resolve()
    expect(test.store.load).toHaveBeenCalledTimes(1)
    write.resolve(undefined)
    await saving
    await reconnect
    expect(test.controller.snapshot().records[0]?.state).toBe('queued')
    expect(test.port.submit).not.toHaveBeenCalled()
  })

  it('recovers a crashed sending record as uncertain instead of sending it again', async () => {
    const test = setup()
    const command: WindowCommand = { requestId: 'recover' as WindowCommand['requestId'], origin: binding, createdAt: 100, expiresAt: 5000, action: { type: 'dispatch', text: 'Task' } }
    test.rows.set(originKey(binding), { version: 'qianshou.pc-window.v1', binding, revision: 1, cursor: null, records: [{ command, state: 'delivering', receipt: null }] })
    await test.controller.connect(binding)
    await test.controller.flush()
    expect(test.controller.snapshot().records[0]?.state).toBe('uncertain')
    expect(test.rows.get(originKey(binding))?.records[0]?.state).toBe('uncertain')
    expect(test.port.submit).not.toHaveBeenCalled()
  })

  it('hides old account data immediately and ignores its delayed receipt after switching', async () => {
    const test = setup()
    const pending = deferred<WindowReceipt>()
    vi.mocked(test.port.submit).mockReturnValueOnce(pending.promise)
    await test.controller.connect(binding)
    await test.controller.enqueue({ type: 'dispatch', text: 'Private task' }, 5000)
    await vi.waitFor(() =>{  expect(test.port.submit).toHaveBeenCalledTimes(1) })
    const command = test.controller.snapshot().records[0]!.command
    const switching = test.controller.connect(otherBinding)
    expect(test.controller.snapshot().records).toEqual([])
    await switching
    pending.resolve(receipt(command))
    await Promise.resolve()
    expect(test.controller.snapshot().binding).toEqual(otherBinding)
    expect(test.controller.snapshot().records).toEqual([])
    expect(test.rows.get(originKey(binding))?.records[0]?.state).toBe('delivering')
  })

  it('rejects a mismatched receipt and never overwrites the original conversation identity', async () => {
    const test = setup()
    vi.mocked(test.port.submit).mockImplementation(async command => receipt(command, { origin: otherBinding }))
    await test.controller.connect(binding)
    await test.controller.enqueue({ type: 'dispatch', text: 'Task' }, 5000)
    await vi.waitFor(() =>{  expect(test.controller.snapshot().error).toBe('PC_WINDOW_RECEIPT_ORIGIN_MISMATCH') })
    expect(test.controller.snapshot().records[0]?.state).toBe('uncertain')
    expect(test.controller.snapshot().binding).toEqual(binding)
  })

  it('does not expose a revoked account or load its stored conversation', async () => {
    const test = setup()
    vi.mocked(test.port.access).mockResolvedValue({ state: 'unauthorized', allowedActions: [] })
    await test.controller.connect(binding)
    expect(test.store.load).not.toHaveBeenCalled()
    expect(test.controller.snapshot().binding).toBeNull()
    await expect(test.controller.enqueue({ type: 'dispatch', text: 'Task' }, 5000)).rejects.toThrow('NOT_CONNECTED')
  })

  it('retains unsupported controls as unsent and distinguishes accepted cancel from confirmed cancellation', async () => {
    const test = setup()
    vi.mocked(test.port.access).mockResolvedValue({ state: 'online', allowedActions: ['dispatch'] })
    await test.controller.connect(binding)
    await test.controller.enqueue({ type: 'cancel', targetSessionId: 'child-a' as SessionId, expectedRevision: 10 }, 5000)
    await vi.waitFor(() =>{  expect(test.controller.snapshot().error).toBe('PC_WINDOW_ACTION_UNAVAILABLE') })
    expect(test.controller.snapshot().records[0]?.state).toBe('queued')
    expect(test.port.submit).not.toHaveBeenCalled()
    vi.mocked(test.port.access).mockResolvedValue({ state: 'online', allowedActions: ['cancel'] })
    await test.controller.flush()
    expect(test.controller.snapshot().records[0]?.state).toBe('received')
    vi.mocked(test.port.sync).mockImplementation(async (origin, cursor) => ({ binding: origin, fromCursor: cursor, nextCursor: 'cancel-confirmed', receipts: [receipt(test.controller.snapshot().records[0]!.command, { revision: 2, state: 'cancelled' })], notReceivedIds: [] }))
    await test.controller.refresh()
    expect(test.controller.snapshot().records[0]?.state).toBe('cancelled')
  })

  it('does not send when persistence fails and never reports a saved local echo', async () => {
    const test = setup()
    vi.mocked(test.store.save).mockRejectedValue(new Error('Storage full'))
    await test.controller.connect(binding)
    await expect(test.controller.enqueue({ type: 'dispatch', text: 'Task' }, 5000)).rejects.toThrow('Storage full')
    expect(test.port.submit).not.toHaveBeenCalled()
    expect(test.controller.snapshot().records).toEqual([])
  })

  it('rejects mismatched or corrupt persisted origins before exposing records', async () => {
    const test = setup()
    vi.mocked(test.store.load).mockResolvedValue({ version: 'qianshou.pc-window.v1', binding: otherBinding, revision: 1, cursor: null, records: [] } satisfies WindowJournal)
    await expect(test.controller.connect(binding)).rejects.toThrow('INVALID_JOURNAL')
    expect(test.controller.snapshot().records).toEqual([])
  })
})
