import { describe, expect, it } from 'vitest'
import type { WindowCommand, WindowCommandRecord } from '../src/types.ts'
import { applyReceipt, parseCommand, parseJournal, parseSyncPage } from '../src/validation.ts'
import { binding, otherBinding, receipt } from './fixtures.client.ts'

const command: WindowCommand = { origin: binding, requestId: 'request-1' as WindowCommand['requestId'], createdAt: 100, expiresAt: 200, action: { type: 'dispatch', text: 'Task' } }
const entry: WindowCommandRecord = { command, state: 'uncertain', receipt: null }

describe('PC-window external boundaries', () => {
  it('checks user text, explicit lifetime and target revision', () => {
    expect(() => parseCommand({ ...command, expiresAt: 99 })).toThrow('INVALID_COMMAND')
    expect(() => parseCommand({ ...command, action: { type: 'dispatch', text: ' ' } })).toThrow('INVALID_TEXT')
    expect(() => parseCommand({ ...command, action: { type: 'cancel', targetSessionId: 'child' } })).toThrow('INVALID_TARGET')
    expect(parseCommand(command)).toEqual(command)
  })

  it('requires an independent child receipt and preserves a newer receipt during replay', () => {
    const { childSessionId: _omitted, ...withoutChild } = receipt(command)
    expect(() => applyReceipt(entry, withoutChild)).toThrow('MISSING_CHILD')
    const current = applyReceipt(entry, receipt(command, { revision: 5 }))
    expect(applyReceipt(current, receipt(command, { revision: 4 }))).toBe(current)
    expect(() => applyReceipt(current, receipt(command, { revision: 6, state: 'rejected' }))).toThrow('RECEIPT_REGRESSION')
    expect(() => applyReceipt(current, receipt(command, { revision: 6, childSessionId: 'another-child' as WindowCommand['origin']['sessionId'] }))).toThrow('CHANGED_CHILD')
  })

  it('refuses an acknowledgement for a definitely unsent withdrawn command', () => {
    expect(() => applyReceipt({ ...entry, state: 'withdrawn' }, receipt(command))).toThrow('UNSENT_RECEIPT')
  })

  it('rejects cross-origin, duplicated and contradictory sync observations', () => {
    const page = { binding, fromCursor: null, nextCursor: 'one', receipts: [receipt(command)], notReceivedIds: [] }
    expect(() => parseSyncPage({ ...page, receipts: [receipt(command, { origin: otherBinding })] })).toThrow('INVALID_SYNC')
    expect(() => parseSyncPage({ ...page, receipts: [receipt(command), receipt(command)] })).toThrow('INVALID_SYNC')
    expect(() => parseSyncPage({ ...page, notReceivedIds: [command.requestId] })).toThrow('CONFLICTING_RECEIPTS')
  })

  it('rejects persisted duplicate commands and success without a PC receipt', () => {
    const journal = { version: 'qianshou.pc-window.v1', binding, revision: 0, cursor: null, records: [entry] }
    expect(() => parseJournal({ ...journal, records: [entry, entry] }, binding)).toThrow('INVALID_RECORD')
    expect(() => parseJournal({ ...journal, records: [{ ...entry, state: 'received' }] }, binding)).toThrow('MISSING_RECEIPT')
    expect(parseJournal(journal, binding)).toEqual(journal)
  })
})
