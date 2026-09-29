import { describe, expect, it } from 'vitest'
import { parseBillingWebhookEvent, parseNodeEarningsLedgerEntry, parsePaymentIntent, parseQuoteConfirmation, parseSubscriptionEntitlement, parseTaskBudgetAuthorization } from '../src/index.ts'

const times = { periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z' }
const base = { version: 'qianshou.subscription.v1', subscriptionId: 'sub-1', accountId: 'acct-1', planId: 'pro', status: 'active', ...times, renewsAt: times.periodEnd, entitlements: { image: 100, video: false }, providerRef: null }

describe('billing contracts', () => {
  it('parses immutable subscription entitlements and strips unknown fields', () => {
    const result = parseSubscriptionEntitlement({ ...base, unknown: 'ignored' })
    expect(result).toMatchObject({ subscriptionId: 'sub-1', entitlements: { image: 100 } })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.entitlements)).toBe(true)
  })
  it('rejects invalid subscription ranges and untrusted entitlement values', () => {
    expect(() => parseSubscriptionEntitlement({ ...base, periodEnd: times.periodStart })).toThrow('BILLING_INVALID_RANGE')
    expect(() => parseSubscriptionEntitlement({ ...base, entitlements: { script: {} } })).toThrow('BILLING_INVALID_FIELD')
  })
  it('keeps budget authorization and quote confirmation separate from payment', () => {
    const auth = parseTaskBudgetAuthorization({ version: 'qianshou.budget-authorization.v1', authorizationId: 'ba-1', accountId: 'acct-1', taskId: 'task-1', quoteId: 'quote-1', amountMinor: 99, currency: 'CNY', status: 'authorized', idempotencyKey: 'idem-1', authorizedAt: times.periodStart, expiresAt: times.periodEnd })
    const confirmation = parseQuoteConfirmation({ version: 'qianshou.quote-confirmation.v1', confirmationId: 'qc-1', accountId: 'acct-1', quoteId: 'quote-1', amountMinor: 99, currency: 'CNY', confirmedAt: times.periodStart, idempotencyKey: 'idem-q' })
    expect(auth.status).toBe('authorized'); expect(confirmation.quoteId).toBe('quote-1')
  })
  it('validates provider-neutral idempotent payment intents without claiming a charge', () => {
    const intent = parsePaymentIntent({ version: 'qianshou.payment-intent.v1', intentId: 'pi-1', accountId: 'acct-1', amountMinor: 100, currency: 'CNY', status: 'processing', idempotencyKey: 'idem-pay', createdAt: times.periodStart, updatedAt: times.periodStart, provider: 'storekit', providerRef: 'opaque-ref', extra: true })
    expect(intent.status).toBe('processing'); expect(intent.providerRef).toBe('opaque-ref')
    expect(() => parsePaymentIntent({ ...intent, amountMinor: 0.1 })).toThrow('BILLING_INVALID_FIELD')
  })
  it('deduplicates webhook identity through event and payload digest fields', () => {
    const event = parseBillingWebhookEvent({ version: 'qianshou.billing-webhook.v1', eventId: 'evt-1', provider: 'play', type: 'refund.succeeded', observedAt: times.periodStart, intentId: 'pi-1', idempotencyKey: 'idem-pay', payloadDigest: 'a'.repeat(64) })
    expect(event.payloadDigest).toHaveLength(64)
    expect(() => parseBillingWebhookEvent({ ...event, payloadDigest: 'x' })).toThrow('BILLING_INVALID_DIGEST')
  })
  it('requires a target for reversal ledger entries and preserves integer minor units', () => {
    const entry = parseNodeEarningsLedgerEntry({ version: 'qianshou.node-earnings.v1', entryId: 'le-1', nodeId: 'node-1', taskId: 'task-1', kind: 'task_earnings', status: 'pending', amountMinor: 42, currency: 'CNY', idempotencyKey: 'ledger-1', occurredAt: times.periodStart, reversesEntryId: null })
    expect(entry.amountMinor).toBe(42)
    expect(() => parseNodeEarningsLedgerEntry({ ...entry, kind: 'reversal', reversesEntryId: null })).toThrow('BILLING_REVERSAL_TARGET_REQUIRED')
  })
  it('rejects unsupported currencies and noncanonical times', () => {
    expect(() => parseQuoteConfirmation({ version: 'qianshou.quote-confirmation.v1', confirmationId: 'qc', accountId: 'a', quoteId: 'q', amountMinor: 1, currency: 'USD', confirmedAt: times.periodStart, idempotencyKey: 'i' })).toThrow('BILLING_INVALID_FIELD')
    expect(() => parseQuoteConfirmation({ version: 'qianshou.quote-confirmation.v1', confirmationId: 'qc', accountId: 'a', quoteId: 'q', amountMinor: 1, currency: 'CNY', confirmedAt: '2026-09-01T00:00:00Z', idempotencyKey: 'i' })).toThrow('BILLING_INVALID_TIMESTAMP')
  })
})
