/** Every refusal that crosses the relay names one stable `PC_WINDOW_*` code and carries no text, token or path. */
import { ConnectFailure } from '@deepseek-ai/dsh-host-qianshou-session-connect/src/validation.ts'
import { describe, expect, it } from 'vitest'
import { MobileSyncFailure, safeFailure } from '../src/failure.ts'

describe('refusal codes', () => {
  it('names the wire code and its fixed status, and keeps a relay code out of the code itself', () => {
    const plain = new MobileSyncFailure('CAPACITY')
    expect(plain).toMatchObject({ code: 'PC_WINDOW_CAPACITY', status: 429, detail: null })
    expect(plain.label()).toBe('PC_WINDOW_CAPACITY')
    const detailed = new MobileSyncFailure('RELAY_REJECTED', 503, 'PC_WINDOW_UPSTREAM')
    expect(detailed).toMatchObject({ code: 'PC_WINDOW_RELAY_REJECTED', status: 503 })
    expect(detailed.label()).toBe('PC_WINDOW_RELAY_REJECTED:PC_WINDOW_UPSTREAM')
  })

  it('keeps the message identical to the wire code so no server text can leak through it', () => {
    expect(new MobileSyncFailure('OWNER_CHANGED').message).toBe('PC_WINDOW_OWNER_CHANGED')
  })
})

describe('refusals arriving from the shared session-connect port', () => {
  it('passes one of this package own refusals through unchanged', () => {
    const own = new MobileSyncFailure('TIMEOUT')
    expect(safeFailure(own)).toBe(own)
  })

  it.each([
    ['storage-failed', 'STORAGE_FAILED'],
    ['cursor-invalid', 'CURSOR_INVALID'],
    ['history-too-large', 'HISTORY_TOO_LARGE'],
    ['timeout', 'TIMEOUT'],
    ['closed', 'CLOSED'],
    ['capacity', 'CAPACITY'],
    ['session-unavailable', 'SESSION_UNAVAILABLE'],
    ['invalid-request', 'SESSION_UNAVAILABLE'],
  ] as const)('translates %s into PC_WINDOW_%s', (code, kind) => {
    expect(safeFailure(new ConnectFailure(code, 409)).kind).toBe(kind)
  })

  it('collapses an unknown internal error into an unavailable Session without any detail', () => {
    const collapsed = safeFailure(new TypeError('sqlite handle released at /Users/owner/private.sqlite'))
    expect(collapsed).toMatchObject({ code: 'PC_WINDOW_SESSION_UNAVAILABLE', status: 503, detail: null })
    expect(collapsed.message).not.toContain('sqlite')
  })
})
