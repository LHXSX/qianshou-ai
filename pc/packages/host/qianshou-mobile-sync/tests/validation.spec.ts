/** Every relay envelope and phone payload is validated before any Session or durable state is touched. */
import { describe, expect, it } from 'vitest'
import { MobileSyncFailure } from '../src/failure.ts'
import {
  isOpaqueId,
  parseBinding,
  parseCommand,
  parseRelayRequest,
  parseRequestIds,
  parseSyncCursor,
  parseTranscriptCursor,
  record,
  SYNC_CURSOR_PREFIX,
  syncCursor,
} from '../src/validation.ts'

const BINDING = { accountId: 'acct-1', pcId: 'pc-1', sessionId: 'sess-1', sourceDeviceId: 'phone-1' }
const DAY = 24 * 60 * 60 * 1000

/** Assert a refusal names one stable wire code rather than leaking a message. */
function refuses(operation: () => unknown, kind: string): void {
  expect(operation).toThrow(MobileSyncFailure)
  try { operation() } catch (error) { expect((error as MobileSyncFailure).kind).toBe(kind) }
}

describe('opaque identifiers', () => {
  it.each(['a', 'acct-1', 'A'.repeat(256), '会话-1'])('accepts %s', (value) => {
    expect(isOpaqueId(value)).toBe(true)
  })

  it.each([['blank', ''], ['whitespace only', '   '], ['a control character', 'a\u0001b'], ['a newline', 'a\nb'], ['over the bound', 'A'.repeat(257)]])(
    'rejects %s', (_case, value) => { expect(isOpaqueId(value)).toBe(false) },
  )

  it.each([[7], [null], [undefined], [{}], [[]]])('rejects the non-string %p', (value) => {
    expect(isOpaqueId(value)).toBe(false)
  })
})

describe('untrusted objects', () => {
  it.each([['null', null], ['an array', []], ['a string', 'x'], ['a number', 7]])('reads %s as empty', (_case, value) => {
    expect(record(value)).toEqual({})
  })

  it('passes a plain object through', () => {
    expect(record({ a: 1 })).toEqual({ a: 1 })
  })
})

describe('bindings', () => {
  it('validates all four axes', () => {
    expect(parseBinding(BINDING)).toEqual(BINDING)
  })

  it('refuses an empty payload as a bad request rather than an invalid command', () => {
    refuses(() => parseBinding({}), 'BAD_REQUEST')
    refuses(() => parseBinding(null), 'BAD_REQUEST')
  })

  it.each(['accountId', 'pcId', 'sessionId', 'sourceDeviceId'])('refuses a missing %s', (field) => {
    refuses(() => parseBinding({ ...BINDING, [field]: '' }), 'BAD_REQUEST')
  })

  it('ignores fields outside the four axes', () => {
    expect(parseBinding({ ...BINDING, role: 'owner' })).toEqual(BINDING)
  })
})

describe('commands', () => {
  const command = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'req-1',
    origin: BINDING,
    createdAt: 1000,
    expiresAt: 1000 + DAY,
    action: { type: 'dispatch', text: '把这段视频压小一点' },
    ...overrides,
  })

  it('validates a dispatch command and trims its text', () => {
    expect(parseCommand(command({ action: { type: 'dispatch', text: '  hello  ' } }))).toMatchObject({
      requestId: 'req-1',
      action: { type: 'dispatch', text: 'hello' },
    })
  })

  it('keeps an optional label and drops an absent one', () => {
    expect(parseCommand(command({ action: { type: 'dispatch', text: 'x', label: 'from phone' } })).action).toEqual({ type: 'dispatch', text: 'x', label: 'from phone' })
    expect(parseCommand(command()).action).not.toHaveProperty('label')
  })

  it('validates append and cancel with their target and revision', () => {
    expect(parseCommand(command({ action: { type: 'append', targetSessionId: 'sess-1', expectedRevision: 3, text: 'more' } })).action)
      .toEqual({ type: 'append', targetSessionId: 'sess-1', expectedRevision: 3, text: 'more' })
    expect(parseCommand(command({ action: { type: 'cancel', targetSessionId: 'sess-1', expectedRevision: 3 } })).action)
      .toEqual({ type: 'cancel', targetSessionId: 'sess-1', expectedRevision: 3 })
  })

  it('refuses an empty or absent payload', () => {
    refuses(() => parseCommand({}), 'COMMAND_INVALID')
    refuses(() => parseCommand(null), 'COMMAND_INVALID')
  })

  it.each([
    ['a missing request id', { requestId: '' }],
    ['an unknown action type', { action: { type: 'reboot' } }],
    ['blank text', { action: { type: 'dispatch', text: '   ' } }],
    ['text that is not a string', { action: { type: 'dispatch', text: 7 } }],
    ['text over the character bound', { action: { type: 'dispatch', text: 'x'.repeat(4097) } }],
    ['text over the byte bound', { action: { type: 'dispatch', text: '中'.repeat(4001) } }],
    ['a NUL in text', { action: { type: 'dispatch', text: 'a\u0000b' } }],
    ['a revision below one', { action: { type: 'append', targetSessionId: 's', expectedRevision: 0, text: 'x' } }],
    ['a fractional instant', { createdAt: 1.5 }],
    ['a negative instant', { createdAt: -1 }],
    ['an expiry at creation', { createdAt: 1000, expiresAt: 1000 }],
    ['an expiry before creation', { createdAt: 2000, expiresAt: 1000 }],
    ['a lifetime past seven days', { createdAt: 0, expiresAt: 7 * DAY + 1 }],
  ])('refuses %s', (_case, overrides) => {
    refuses(() => parseCommand(command(overrides)), 'COMMAND_INVALID')
  })

  it('accepts a lifetime of exactly seven days', () => {
    expect(parseCommand(command({ createdAt: 0, expiresAt: 7 * DAY }))).toMatchObject({ expiresAt: 7 * DAY })
  })
})

describe('receipt-stream cursors', () => {
  it('reads absence as the stream start', () => {
    expect(parseSyncCursor(null)).toBe(0)
    expect(parseSyncCursor(undefined)).toBe(0)
  })

  it('round-trips a position through its own format', () => {
    expect(parseSyncCursor(syncCursor(42))).toBe(42)
    expect(syncCursor(42)).toBe(`${SYNC_CURSOR_PREFIX}:42`)
  })

  it.each([
    ['another prefix', 'qianshou.other.cursor.v1:1'],
    ['a missing sequence', `${SYNC_CURSOR_PREFIX}:`],
    ['a non-numeric sequence', `${SYNC_CURSOR_PREFIX}:one`],
    ['more digits than the format allows', `${SYNC_CURSOR_PREFIX}:${'9'.repeat(16)}`],
    ['a trailing segment', `${SYNC_CURSOR_PREFIX}:1:2`],
    ['a number instead of a string', 7],
  ])('refuses %s', (_case, value) => {
    refuses(() => parseSyncCursor(value), 'CURSOR_INVALID')
  })
})

describe('reconciled request ids', () => {
  it('reads absence as none and validates each id', () => {
    expect(parseRequestIds(undefined)).toEqual([])
    expect(parseRequestIds(['req-1', 'req-2'])).toEqual(['req-1', 'req-2'])
  })

  it.each([
    ['a non-array', 'req-1'],
    ['more ids than the bound accepts', Array.from({ length: 501 }, (_unused, index) => `req-${String(index)}`)],
    ['a blank id', ['']],
  ])('refuses %s', (_case, value) => {
    refuses(() => parseRequestIds(value), 'BAD_REQUEST')
  })
})

describe('transcript cursors', () => {
  it('passes a bounded opaque string and absence through', () => {
    expect(parseTranscriptCursor(null)).toBeNull()
    expect(parseTranscriptCursor(undefined)).toBeNull()
    expect(parseTranscriptCursor('opaque')).toBe('opaque')
  })

  it.each([['a value over the bound', 'x'.repeat(161)], ['a non-string', 7]])('refuses %s', (_case, value) => {
    refuses(() => parseTranscriptCursor(value), 'CURSOR_INVALID')
  })
})

describe('forwarded relay envelopes', () => {
  it('validates the five forwardable actions', () => {
    for (const action of ['bootstrap', 'access', 'transcript', 'sync', 'submit']) {
      expect(parseRelayRequest({ id: 'd-1', action, accountId: 'acct-1', payload: { a: 1 } })).toEqual({
        id: 'd-1', action, accountId: 'acct-1', payload: { a: 1 },
      })
    }
  })

  it('reads a missing payload as empty rather than refusing the delivery', () => {
    expect(parseRelayRequest({ id: 'd-1', action: 'access', accountId: 'acct-1' }).payload).toEqual({})
  })

  it.each([
    ['an action this PC does not forward', { id: 'd-1', action: 'revoke', accountId: 'a' }],
    ['a missing delivery id', { id: '', action: 'access', accountId: 'a' }],
    ['a missing account', { id: 'd-1', action: 'access', accountId: '' }],
    ['a non-string action', { id: 'd-1', action: 7, accountId: 'a' }],
  ])('refuses %s as an invalid relay reply', (_case, value) => {
    refuses(() => parseRelayRequest(value), 'RELAY_INVALID_REPLY')
  })
})
