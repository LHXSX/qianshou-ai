import { describe, expect, it } from 'vitest'
import { BillingContractError, parseQuoteConfirmation, parseTaskBudgetAuthorization } from '../src/index.ts'
import {
  DEFAULT_PRICING, DEFAULT_PRICING_SPLIT, PRICING_BASIS_POINTS, allocateSplit, createPricingConfig,
  quoteTask, resolveTaskPricing, sumSplitMinor,
} from '../src/pricing.ts'
import type { PricingSplitBps } from '../src/pricing.ts'

/** The five financial fields the isolated server returned for one word_count task (2026-09-14T22:44:52Z). */
const SERVER_ESTIMATE = { estimatedTotal: '0.50', recommendedBudget: '0.50', workerRewardPool: '0.32', platformFee: '0.15', riskPool: '0.00', scriptAuthorFee: '0.02' } as const
const fen = (yuan: string): number => Math.round(Number(yuan) * 100)
/** The same numbers, declared as an operator fact for this deployment rather than a local default. */
const hosted = createPricingConfig({ pricingSource: 'host_config' })

describe('configured task pricing', () => {
  it('ships defaults that are usable without any override and keep the five observed ports', () => {
    const config = createPricingConfig()
    expect(config).toMatchObject({ version: 'qianshou.pricing.v1', currency: 'CNY', pricingSource: 'local_default', remainderRecipient: 'workerRewardPool' })
    expect(Object.isFrozen(config)).toBe(true)
    const quote = quoteTask(config, 'word_count', 1)
    expect(Object.keys(quote.breakdown)).toEqual(['workerRewardPool', 'platformFee', 'riskPool', 'scriptAuthorFee'])
    expect(quote).toMatchObject({ version: 'qianshou.pricing.v1', currency: 'CNY', unit: 'file', rateMinor: 50, chargedUnits: 1, minimumApplied: false, billingMode: 'configured_fallback', authority: 'estimate-only' })
  })
  it('never lets a local default claim the server price while a host configuration may', () => {
    expect(quoteTask(DEFAULT_PRICING, 'word_count', 1).billingMode).toBe('configured_fallback')
    expect(quoteTask(hosted, 'word_count', 1).billingMode).toBe('server_price')
    expect(hosted.pricingSource).toBe('host_config')
    expect(() => createPricingConfig({ pricingSource: 'remote' as never })).toThrow('PRICING_UNKNOWN_VALUE')
    // Both sides stay advisory: neither may be read as a reservation or an order.
    expect(quoteTask(hosted, 'word_count', 1).authority).toBe('estimate-only')
    expect(quoteTask(DEFAULT_PRICING, 'word_count', 1).authority).toBe('estimate-only')
  })
  it('reproduces the server estimate total and recommended budget for the one real word_count sample', () => {
    const quote = quoteTask(DEFAULT_PRICING, 'word_count', 1)
    expect(quote.estimatedTotalMinor).toBe(fen(SERVER_ESTIMATE.estimatedTotal))
    expect(quote.recommendedBudgetMinor).toBe(fen(SERVER_ESTIMATE.recommendedBudget))
    const parts = [quote.breakdown.workerRewardPool, quote.breakdown.platformFee, quote.breakdown.riskPool, quote.breakdown.scriptAuthorFee]
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(fen(SERVER_ESTIMATE.estimatedTotal))
  })
  it('accepts only a split that sums to exactly the basis-point total', () => {
    const sum = Object.values(DEFAULT_PRICING_SPLIT).reduce((total, share) => total + share, 0)
    expect(sum).toBe(PRICING_BASIS_POINTS)
    expect(() => createPricingConfig({ split: { workerRewardPool: 6400, platformFee: 3000, riskPool: 0, scriptAuthorFee: 400 } })).toThrow('PRICING_SPLIT_NOT_TOTAL')
    expect(() => createPricingConfig({ split: { workerRewardPool: 9800 } })).toThrow('PRICING_SPLIT_NOT_TOTAL')
    expect(() => createPricingConfig({ split: { workerRewardPool: 9000, platformFee: 0, riskPool: 0, scriptAuthorFee: 0 } })).toThrow('PRICING_SPLIT_NOT_TOTAL')
  })
  it('rejects out-of-range, fractional and non-numeric split shares with a stable error code', () => {
    const cases = [{ workerRewardPool: 6500.5 }, { workerRewardPool: -1 }, { workerRewardPool: 10001 }]
    for (const split of cases) {
      try { createPricingConfig({ split }); throw new Error('expected a throw') } catch (error) {
        expect(error, JSON.stringify(split)).toBeInstanceOf(BillingContractError)
        expect((error as BillingContractError).code).toBe('PRICING_INVALID_SPLIT_SHARE')
        expect((error as BillingContractError).message).toContain('split.workerRewardPool')
      }
    }
    expect(() => createPricingConfig({ split: { platformFee: Number.NaN } })).toThrow('PRICING_INVALID_SPLIT_SHARE')
  })
  it('merges a partial override onto the defaults and leaves unrelated defaults untouched', () => {
    const config = createPricingConfig({ prices: { video_second: { rateMinor: 100 } } })
    expect(resolveTaskPricing(config, 'video_second').rateMinor).toBe(100)
    expect(resolveTaskPricing(config, 'video_second').unit).toBe('second')
    expect(resolveTaskPricing(config, 'video_second').minimumUnits).toBe(5)
    expect(resolveTaskPricing(config, 'video_second').note).toBe(DEFAULT_PRICING.prices.video_second.note)
    expect(resolveTaskPricing(config, 'word_count')).toEqual(DEFAULT_PRICING.prices.word_count)
    expect(DEFAULT_PRICING.prices.video_second.rateMinor).toBe(35)
    expect(() => createPricingConfig({ prices: { video_second: { rateMinor: -1 } } })).toThrow('PRICING_INVALID_RATE')
    expect(() => createPricingConfig({ prices: { video_second: { minimumUnits: 0 } } })).toThrow('PRICING_INVALID_MINIMUM_UNITS')
    // `minute` became a billable unit on 2026-09-17 (compute_second is priced per GPU-minute),
    // so it can no longer be used as the "unknown unit" sample. What this assertion is really
    // protecting is that an unknown unit from a JSON config is rejected rather than trusted —
    // including a near-miss spelling, which is the shape a typo in a config file would take.
    expect(createPricingConfig({ prices: { compute_second: { unit: 'minute' } } }).prices.compute_second.unit).toBe('minute')
    expect(() => createPricingConfig({ prices: { video_second: { unit: 'minutes' } as unknown as { unit: 'second' } } })).toThrow('PRICING_UNKNOWN_VALUE')
    expect(() => createPricingConfig({ prices: { video_second: { unit: 'minute' } as unknown as { unit: 'second' } } })).not.toThrow()
    // `minute` is accepted because the whitelist is global, not per task kind — so the whitelist
    // must stay closed on every path: a unit that is genuinely not billable is still rejected,
    // and the resolution path reports the minute unit and its one-minute floor.
    expect(() => createPricingConfig({ prices: { compute_second: { unit: 'hour' } as unknown as { unit: 'minute' } } })).toThrow('PRICING_UNKNOWN_VALUE')
    expect(resolveTaskPricing(DEFAULT_PRICING, 'compute_second')).toMatchObject({ unit: 'minute', minimumUnits: 1 })
  })
  it('rejects unknown task types, unknown currencies and unknown remainder recipients', () => {
    expect(() => quoteTask(DEFAULT_PRICING, 'audio_minute' as never, 1)).toThrow('PRICING_UNKNOWN_VALUE')
    expect(() => resolveTaskPricing(DEFAULT_PRICING, 'unknown_kind' as never)).toThrow('PRICING_UNKNOWN_VALUE')
    expect(() => createPricingConfig({ currency: 'USD' as never })).toThrow('PRICING_INVALID_CURRENCY')
    expect(() => createPricingConfig({ remainderRecipient: 'channelPool' as never })).toThrow('PRICING_UNKNOWN_VALUE')
    expect(() => quoteTask(DEFAULT_PRICING, 'word_count', 1.5)).toThrow('PRICING_INVALID_AMOUNT')
  })
  it('charges a video task by the second and scales linearly above the minimum', () => {
    const short = quoteTask(DEFAULT_PRICING, 'video_second', 1)
    const three = quoteTask(DEFAULT_PRICING, 'video_second', 3)
    const ten = quoteTask(DEFAULT_PRICING, 'video_second', 10)
    // One and three seconds are below the five-second default minimum, so they are charged as five.
    expect(short).toMatchObject({ minimumApplied: true, chargedUnits: 5, estimatedTotalMinor: 175 })
    expect(three).toMatchObject({ minimumApplied: true, chargedUnits: 5, estimatedTotalMinor: 175 })
    expect(ten).toMatchObject({ minimumApplied: false, chargedUnits: 10, estimatedTotalMinor: 350 })
    expect([short, three, ten].every(quote => quote.unit === 'second')).toBe(true)
    expect(quoteTask(DEFAULT_PRICING, 'video_second', 20).estimatedTotalMinor).toBe(20 * 35)
    expect(quoteTask(DEFAULT_PRICING, 'video_second', 7).estimatedTotalMinor).toBe(7 * 35)
    const cheap = createPricingConfig({ prices: { video_second: { rateMinor: 18 } } })
    const pricey = createPricingConfig({ prices: { video_second: { rateMinor: 138 } } })
    expect(quoteTask(cheap, 'video_second', 5).estimatedTotalMinor).toBe(90)
    expect(quoteTask(pricey, 'video_second', 5).estimatedTotalMinor).toBe(690)
    expect(quoteTask(cheap, 'video_second', 120).estimatedTotalMinor).toBe(2160)
  })
  it('applies the configured minimum charge instead of a hidden one', () => {
    const short = quoteTask(DEFAULT_PRICING, 'video_second', 2)
    expect(short.requestedUnits).toBe(2)
    expect(short.chargedUnits).toBe(5)
    expect(short.minimumUnits).toBe(5)
    expect(short.minimumApplied).toBe(true)
    expect(short.estimatedTotalMinor).toBe(175)
    const exact = quoteTask(DEFAULT_PRICING, 'video_second', 5)
    expect(exact.minimumApplied).toBe(false)
    // compute_second 的单位现为 **minute**（2026-09-17 用户定价：3.6 元/GPU·小时 = 6 分/分钟）。
    // 原 unit:'second' + rateMinor:10 等于 ¥360/小时，是意图值的 100 倍。
    // 起算量也要跟着换算：旧 minimumUnits:60 计的是秒（= 1 分钟起算），故现在是 1 分钟。
    const gpuMinute = quoteTask(DEFAULT_PRICING, 'compute_second', 1)
    expect(gpuMinute).toMatchObject({ unit: 'minute', chargedUnits: 1, minimumApplied: false, estimatedTotalMinor: 6 })
    const gpuHour = quoteTask(DEFAULT_PRICING, 'compute_second', 60)
    expect(gpuHour).toMatchObject({ chargedUnits: 60, minimumApplied: false, estimatedTotalMinor: 360 })
    const gpuTenMinutes = quoteTask(DEFAULT_PRICING, 'compute_second', 600)
    expect(gpuTenMinutes.estimatedTotalMinor).toBe(3600)
  })
  it('splits a word_count total across the observed ports with integer fen only', () => {
    expect(quoteTask(DEFAULT_PRICING, 'word_count', 1).breakdown).toEqual({ workerRewardPool: 33, platformFee: 15, riskPool: 0, scriptAuthorFee: 2 })
    // Second two-file sample: 65.00 + 30.00 + 0.00 + 5.00, the unallocated fen going to the
    // largest fractional share rather than being dropped as the server's floor-only split does.
    expect(quoteTask(DEFAULT_PRICING, 'word_count', 2).breakdown).toEqual({ workerRewardPool: 65, platformFee: 30, riskPool: 0, scriptAuthorFee: 5 })
    expect(quoteTask(DEFAULT_PRICING, 'video_second', 10).breakdown).toEqual({ workerRewardPool: 228, platformFee: 105, riskPool: 0, scriptAuthorFee: 17 })
    for (const quote of [quoteTask(DEFAULT_PRICING, 'word_count', 3), quoteTask(DEFAULT_PRICING, 'video_second', 7), quoteTask(DEFAULT_PRICING, 'compute_second', 61)]) {
      for (const part of Object.values(quote.breakdown)) expect(Number.isSafeInteger(part)).toBe(true)
      expect(Object.values(quote.breakdown).every(part => part >= 0)).toBe(true)
      expect(sumSplitMinor(quote.breakdown)).toBe(quote.estimatedTotalMinor)
    }
  })
  it('keeps parts equal to the total for every amount despite integer flooring', () => {
    for (let total = 0; total <= 200; total += 1) {
      const parts = allocateSplit(DEFAULT_PRICING_SPLIT, total)
      expect(sumSplitMinor(parts), `total=${total}`).toBe(total)
      expect(parts.workerRewardPool).toBeGreaterThanOrEqual(parts.platformFee)
    }
    // Pathological ratios maximise the leftover: every fen can land on one port, so the remainder
    // rule — not the ratio arithmetic — is what keeps the four ports summing to the total.
    const lopsided: PricingSplitBps = { workerRewardPool: 1, platformFee: 9997, riskPool: 1, scriptAuthorFee: 1 }
    for (const total of [1, 2, 3, 7, 99, 12345, 99999]) {
      const parts = allocateSplit(lopsided, total)
      expect(sumSplitMinor(parts), `lopsided total=${total}`).toBe(total)
      expect(Math.min(parts.workerRewardPool, parts.platformFee, parts.riskPool, parts.scriptAuthorFee)).toBeGreaterThanOrEqual(0)
    }
    const lopsidedQuote = quoteTask(createPricingConfig({ split: lopsided, pricingSource: 'host_config' }), 'compute_second', 61)
    expect(sumSplitMinor(lopsidedQuote.breakdown)).toBe(lopsidedQuote.estimatedTotalMinor)
    // 61 GPU-minutes at 6 fen/minute = 366 fen (¥3.66). This assertion used to read 610 because
    // compute_second was mis-priced at 10 fen/second (¥360/hour instead of ¥3.60/hour).
    expect(lopsidedQuote.estimatedTotalMinor).toBe(366)
  })
  it('honours an overridden split, a funded risk pool and a declared remainder recipient', () => {
    const funded = createPricingConfig({ split: { workerRewardPool: 6500, platformFee: 2500, riskPool: 500, scriptAuthorFee: 500 }, remainderRecipient: 'riskPool' })
    const quote = quoteTask(funded, 'word_count', 1)
    // 32.50 / 12.50 / 2.50 / 2.50 floors to 32 / 12 / 2 / 2; the risk pool is the declared
    // remainder recipient, so the unallocated fen lands there (33 + 12 + 3 + 2 = 50).
    expect(quote.breakdown).toEqual({ workerRewardPool: 33, platformFee: 12, riskPool: 3, scriptAuthorFee: 2 })
    expect(quote.breakdown.riskPool).toBeGreaterThan(0)
    expect(sumSplitMinor(quote.breakdown)).toBe(50)
    const zeroRate = createPricingConfig({ prices: { compute_second: { rateMinor: 0 } } })
    expect(quoteTask(zeroRate, 'compute_second', 120)).toMatchObject({ estimatedTotalMinor: 0, breakdown: { workerRewardPool: 0, platformFee: 0, riskPool: 0, scriptAuthorFee: 0 } })
  })
  it('is reachable through the package root export and keeps the budget/quote separation', () => {
    const quote = quoteTask(createPricingConfig(), 'word_count', 1)
    const budget = parseTaskBudgetAuthorization({ version: 'qianshou.budget-authorization.v1', authorizationId: 'ba-1', accountId: 'acct-1', taskId: 'task-1', quoteId: 'quote-1', amountMinor: quote.recommendedBudgetMinor, currency: quote.currency, status: 'proposed', idempotencyKey: 'idem-1', authorizedAt: null, expiresAt: '2026-10-01T00:00:00.000Z' })
    const confirmation = parseQuoteConfirmation({ version: 'qianshou.quote-confirmation.v1', confirmationId: 'qc-1', accountId: 'acct-1', quoteId: 'quote-1', amountMinor: quote.estimatedTotalMinor, currency: quote.currency, confirmedAt: '2026-09-15T00:00:00.000Z', idempotencyKey: 'idem-q' })
    expect(quote.authority).toBe('estimate-only')
    expect(budget.amountMinor).toBe(quote.recommendedBudgetMinor)
    expect(confirmation.amountMinor).toBe(quote.estimatedTotalMinor)
    expect(budget.status).toBe('proposed')
    expect(quote).not.toHaveProperty('requestedBudgetMinor')
    expect(quote).not.toHaveProperty('idempotencyKey')
  })
})
