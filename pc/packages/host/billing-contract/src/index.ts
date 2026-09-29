/** Provider-neutral commercial contracts; adapters own transport and settlement. */

export type BillingCurrency = 'CNY'
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled' | 'expired'
export type PaymentIntentStatus = 'requires_confirmation' | 'requires_action' | 'processing' | 'succeeded' | 'failed' | 'canceled'
export type BudgetAuthorizationStatus = 'proposed' | 'authorized' | 'consumed' | 'voided' | 'refunded'
export type LedgerEntryStatus = 'pending' | 'available' | 'reversed'
export type LedgerEntryKind = 'task_earnings' | 'platform_fee' | 'adjustment' | 'reversal'

export interface SubscriptionEntitlement {
  version: 'qianshou.subscription.v1'
  subscriptionId: string
  accountId: string
  planId: string
  status: SubscriptionStatus
  periodStart: string
  periodEnd: string
  renewsAt: string | null
  entitlements: Readonly<Record<string, number | boolean | string>>
  providerRef: string | null
}
export interface TaskBudgetAuthorization {
  version: 'qianshou.budget-authorization.v1'
  authorizationId: string
  accountId: string
  taskId: string
  quoteId: string
  amountMinor: number
  currency: BillingCurrency
  status: BudgetAuthorizationStatus
  idempotencyKey: string
  authorizedAt: string | null
  expiresAt: string
}
export interface QuoteConfirmation {
  version: 'qianshou.quote-confirmation.v1'
  confirmationId: string
  accountId: string
  quoteId: string
  amountMinor: number
  currency: BillingCurrency
  confirmedAt: string
  idempotencyKey: string
}
export interface PaymentIntent {
  version: 'qianshou.payment-intent.v1'
  intentId: string
  accountId: string
  amountMinor: number
  currency: BillingCurrency
  status: PaymentIntentStatus
  idempotencyKey: string
  createdAt: string
  updatedAt: string
  provider: string | null
  providerRef: string | null
}
export type BillingWebhookEventType =
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.canceled'
  | 'refund.requested'
  | 'refund.succeeded'
  | 'refund.failed'
export interface BillingWebhookEvent {
  version: 'qianshou.billing-webhook.v1'
  eventId: string
  provider: string
  type: BillingWebhookEventType
  observedAt: string
  intentId: string | null
  idempotencyKey: string | null
  payloadDigest: string
}
export interface NodeEarningsLedgerEntry {
  version: 'qianshou.node-earnings.v1'
  entryId: string
  nodeId: string
  taskId: string
  kind: LedgerEntryKind
  status: LedgerEntryStatus
  amountMinor: number
  currency: BillingCurrency
  idempotencyKey: string
  occurredAt: string
  reversesEntryId: string | null
}

export class BillingContractError extends Error {
  constructor(readonly code: string, field?: string) { super(field === undefined ? code : `${code}: ${field}`); this.name = 'BillingContractError' }
}
const MAX_ID = 256, MAX_PROVIDER = 128, MAX_ENTITLEMENTS = 64, MAX_DIGEST = 128
const SHA256 = /^[a-f0-9]{64}$/u
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

export function parseSubscriptionEntitlement(value: unknown): SubscriptionEntitlement {
  const item = object(value)
  const result: SubscriptionEntitlement = {
    version: exact(item.version, 'qianshou.subscription.v1', 'version'), subscriptionId: id(item.subscriptionId, 'subscriptionId'), accountId: id(item.accountId, 'accountId'), planId: id(item.planId, 'planId'), status: enumValue(item.status, ['trialing', 'active', 'past_due', 'paused', 'canceled', 'expired'], 'status'),
    periodStart: iso(item.periodStart, 'periodStart'), periodEnd: iso(item.periodEnd, 'periodEnd'), renewsAt: item.renewsAt === null ? null : iso(item.renewsAt, 'renewsAt'), entitlements: entitlementMap(item.entitlements), providerRef: item.providerRef === null ? null : bounded(item.providerRef, 'providerRef', MAX_PROVIDER),
  }
  if (Date.parse(result.periodEnd) <= Date.parse(result.periodStart)) fail('BILLING_INVALID_RANGE', 'periodEnd')
  return freeze(result)
}
export function parseTaskBudgetAuthorization(value: unknown): TaskBudgetAuthorization {
  const item = object(value)
  return freeze({ version: exact(item.version, 'qianshou.budget-authorization.v1', 'version'), authorizationId: id(item.authorizationId, 'authorizationId'), accountId: id(item.accountId, 'accountId'), taskId: id(item.taskId, 'taskId'), quoteId: id(item.quoteId, 'quoteId'), amountMinor: amount(item.amountMinor, 'amountMinor'), currency: currency(item.currency), status: enumValue(item.status, ['proposed', 'authorized', 'consumed', 'voided', 'refunded'], 'status'), idempotencyKey: id(item.idempotencyKey, 'idempotencyKey'), authorizedAt: item.authorizedAt === null ? null : iso(item.authorizedAt, 'authorizedAt'), expiresAt: iso(item.expiresAt, 'expiresAt') })
}
export function parseQuoteConfirmation(value: unknown): QuoteConfirmation {
  const item = object(value)
  return freeze({ version: exact(item.version, 'qianshou.quote-confirmation.v1', 'version'), confirmationId: id(item.confirmationId, 'confirmationId'), accountId: id(item.accountId, 'accountId'), quoteId: id(item.quoteId, 'quoteId'), amountMinor: amount(item.amountMinor, 'amountMinor'), currency: currency(item.currency), confirmedAt: iso(item.confirmedAt, 'confirmedAt'), idempotencyKey: id(item.idempotencyKey, 'idempotencyKey') })
}
export function parsePaymentIntent(value: unknown): PaymentIntent {
  const item = object(value)
  return freeze({ version: exact(item.version, 'qianshou.payment-intent.v1', 'version'), intentId: id(item.intentId, 'intentId'), accountId: id(item.accountId, 'accountId'), amountMinor: amount(item.amountMinor, 'amountMinor'), currency: currency(item.currency), status: enumValue(item.status, ['requires_confirmation', 'requires_action', 'processing', 'succeeded', 'failed', 'canceled'], 'status'), idempotencyKey: id(item.idempotencyKey, 'idempotencyKey'), createdAt: iso(item.createdAt, 'createdAt'), updatedAt: iso(item.updatedAt, 'updatedAt'), provider: item.provider === null ? null : bounded(item.provider, 'provider', MAX_PROVIDER), providerRef: item.providerRef === null ? null : bounded(item.providerRef, 'providerRef', MAX_PROVIDER) })
}
export function parseBillingWebhookEvent(value: unknown): BillingWebhookEvent {
  const item = object(value), digest = bounded(item.payloadDigest, 'payloadDigest', MAX_DIGEST)
  if (!SHA256.test(digest)) fail('BILLING_INVALID_DIGEST', 'payloadDigest')
  return freeze({ version: exact(item.version, 'qianshou.billing-webhook.v1', 'version'), eventId: id(item.eventId, 'eventId'), provider: bounded(item.provider, 'provider', MAX_PROVIDER), type: enumValue(item.type, ['payment.succeeded', 'payment.failed', 'payment.canceled', 'refund.requested', 'refund.succeeded', 'refund.failed'], 'type'), observedAt: iso(item.observedAt, 'observedAt'), intentId: item.intentId === null ? null : id(item.intentId, 'intentId'), idempotencyKey: item.idempotencyKey === null ? null : id(item.idempotencyKey, 'idempotencyKey'), payloadDigest: digest })
}
export function parseNodeEarningsLedgerEntry(value: unknown): NodeEarningsLedgerEntry {
  const item = object(value), reverses = item.reversesEntryId === null ? null : id(item.reversesEntryId, 'reversesEntryId'), kind = enumValue(item.kind, ['task_earnings', 'platform_fee', 'adjustment', 'reversal'], 'kind')
  if (kind === 'reversal' && reverses === null) fail('BILLING_REVERSAL_TARGET_REQUIRED', 'reversesEntryId')
  return freeze({ version: exact(item.version, 'qianshou.node-earnings.v1', 'version'), entryId: id(item.entryId, 'entryId'), nodeId: id(item.nodeId, 'nodeId'), taskId: id(item.taskId, 'taskId'), kind, status: enumValue(item.status, ['pending', 'available', 'reversed'], 'status'), amountMinor: amount(item.amountMinor, 'amountMinor'), currency: currency(item.currency), idempotencyKey: id(item.idempotencyKey, 'idempotencyKey'), occurredAt: iso(item.occurredAt, 'occurredAt'), reversesEntryId: reverses })
}
function object(value: unknown): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('BILLING_INVALID_OBJECT'); return value as Record<string, unknown> }
function fail(code: string, field?: string): never { throw new BillingContractError(code, field) }
function exact<T extends string>(value: unknown, expected: T, field: string): T { if (value !== expected) fail('BILLING_INVALID_FIELD', field); return expected }
function bounded(value: unknown, field: string, max: number): string { if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value) || value.trim() !== value) fail('BILLING_INVALID_FIELD', field); return value }
function id(value: unknown, field: string): string { return bounded(value, field, MAX_ID) }
function amount(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) fail('BILLING_INVALID_FIELD', field); return value as number }
function currency(value: unknown): BillingCurrency { if (value !== 'CNY') fail('BILLING_INVALID_FIELD', 'currency'); return value }
function iso(value: unknown, field: string): string { const text = bounded(value, field, 40); if (!ISO.test(text) || Number.isNaN(Date.parse(text))) fail('BILLING_INVALID_TIMESTAMP', field); return text }
function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T { if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail('BILLING_INVALID_FIELD', field); return value as T }
function entitlementMap(value: unknown): Readonly<Record<string, number | boolean | string>> { const item = object(value), entries = Object.entries(item); if (entries.length > MAX_ENTITLEMENTS) fail('BILLING_ENTITLEMENTS_TOO_LARGE'); const out: Record<string, number | boolean | string> = {}; for (const [key, val] of entries) { bounded(key, 'entitlement key', 128); if ((typeof val !== 'string' && typeof val !== 'boolean' && !Number.isSafeInteger(val)) || (typeof val === 'string' && val.length > 256)) fail('BILLING_INVALID_FIELD', `entitlements.${key}`); out[key] = val as number | boolean | string } return Object.freeze(out) }
function freeze<T extends object>(value: T): T { return Object.freeze(value) }

export * from './pricing.ts'
