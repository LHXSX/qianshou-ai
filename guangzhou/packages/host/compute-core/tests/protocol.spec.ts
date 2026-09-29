import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ComputeCapabilityId,
  ComputePlanId,
  ComputeQuoteId,
  ComputeWorkloadId,
  type ComputePlanRequest,
} from '../src/protocol.ts'
import {
  MAX_COMPUTE_GOAL_CHARS,
  MAX_COMPUTE_ID_CHARS,
  MAX_COMPUTE_REQUEST_NODES,
    parsePlanRequest,
    parsePlanConfirmation,
    parsePlanPublish,
    parseQuote,
    parseTaskEnvelope,
} from '../src/validation.ts'

const request = {
  capabilityId: 'image.batch',
  goal: '处理这批图片，保持尺寸。',
  budgetMinor: 50,
  currency: 'CNY',
  maxNodes: null,
}

const quote = {
  id: 'quote-1',
  planId: 'plan-1',
  currency: 'CNY',
  amountMinor: 50,
  expiresAt: '2026-09-14T12:00:00.000Z',
}

describe('compute planning JSON', () => {
  it('keeps integer fen and auto concurrency without creating a quote or authorization', () => {
    const parsed = parsePlanRequest({ ...request, quote, approved: true, apiKey: 'ignored-test-field' })
    expect(parsed).toEqual(request)
    expectTypeOf(parsed).toEqualTypeOf<ComputePlanRequest>()
    expectTypeOf(parsed.capabilityId).toEqualTypeOf<ComputeCapabilityId>()
  })

  it.each([0, 1, 50, Number.MAX_SAFE_INTEGER])('preserves exact minor units: %s', (budgetMinor) => {
    expect(parsePlanRequest({ ...request, budgetMinor }).budgetMinor).toBe(budgetMinor)
  })

  it.each([-1, 0.5, 50.01, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '50', null, undefined])(
    'rejects inexact, unsafe or missing budget: %s',
    (budgetMinor) => {
      expect(() => parsePlanRequest({ ...request, budgetMinor })).toThrow('INVALID_COMPUTE_FIELD: budgetMinor')
    },
  )

  it.each([1, MAX_COMPUTE_REQUEST_NODES])('accepts an explicit concurrency ceiling: %s', (maxNodes) => {
    expect(parsePlanRequest({ ...request, maxNodes }).maxNodes).toBe(maxNodes)
  })

  it.each([0, -1, 1.5, MAX_COMPUTE_REQUEST_NODES + 1, Infinity, NaN, '3', undefined])(
    'rejects invalid concurrency instead of silently falling back to automatic: %s',
    (maxNodes) => {
      expect(() => parsePlanRequest({ ...request, maxNodes })).toThrow('INVALID_COMPUTE_FIELD: maxNodes')
    },
  )

  it.each([null, undefined, [], 'request', 3])('requires a JSON object: %s', (value) => {
    expect(() => parsePlanRequest(value)).toThrow('INVALID_COMPUTE_OBJECT')
  })

  it('requires every planning field explicitly', () => {
    for (const key of Object.keys(request)) {
      const omitted = Object.fromEntries(Object.entries(request).filter(([field]) => field !== key))
      expect(() => parsePlanRequest(omitted)).toThrow(`INVALID_COMPUTE_FIELD: ${key}`)
    }
  })

  it('admits the exact goal limit and preserves multiline user wording', () => {
    const goal = `处理\n${'图'.repeat(MAX_COMPUTE_GOAL_CHARS - 3)}`
    expect(parsePlanRequest({ ...request, goal }).goal).toBe(goal)
  })

  it.each(['', ' \n\t ', '图'.repeat(MAX_COMPUTE_GOAL_CHARS + 1), '处理\0图片', 5])(
    'rejects empty, oversized or invalid goal: %#',
    (goal) => {
      expect(() => parsePlanRequest({ ...request, goal })).toThrow('INVALID_COMPUTE_FIELD: goal')
    },
  )

  it('admits the exact identity limit', () => {
    const capabilityId = 'c'.repeat(MAX_COMPUTE_ID_CHARS)
    expect(parsePlanRequest({ ...request, capabilityId }).capabilityId).toBe(capabilityId)
  })

  it.each(['', ' id', 'id ', 'id\nnext', 'id\0next', 'id\u007f', 'a'.repeat(MAX_COMPUTE_ID_CHARS + 1), 7])(
    'rejects malformed capability identity: %#',
    (capabilityId) => {
      expect(() => parsePlanRequest({ ...request, capabilityId })).toThrow('INVALID_COMPUTE_FIELD: capabilityId')
    },
  )

  it.each(['USD', 'cny', '', null])('does not convert unsupported currency: %s', (currency) => {
    expect(() => parsePlanRequest({ ...request, currency })).toThrow('INVALID_COMPUTE_FIELD: currency')
  })
})

describe('compute plan confirmation JSON', () => {
  const confirmation = {
    id: 'plan_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    decision: 'approved' as const,
  }

  it('admits an owner decision without inventing a quote or submit', () => {
    expect(parsePlanConfirmation({ ...confirmation, quote: { id: 'forged' }, approved: true, submit: true })).toEqual(confirmation)
  })

  it.each(['declined', 'approved'])('admits decision %s', (decision) => {
    expect(parsePlanConfirmation({ ...confirmation, decision }).decision).toBe(decision)
  })

  it.each(['pending', 'submit', 'yes', '', null, undefined])('rejects a non-decision: %s', (decision) => {
    expect(() => parsePlanConfirmation({ ...confirmation, decision })).toThrow('INVALID_COMPUTE_FIELD: decision')
  })

  it.each(['plan-1', 'plan_', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '', 3])('rejects a non-host plan identity: %s', (id) => {
    expect(() => parsePlanConfirmation({ ...confirmation, id })).toThrow('INVALID_COMPUTE_FIELD: id')
  })
})

describe('compute plan publish JSON', () => {
  const publish = { id: 'plan_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }

  it('admits a plan identity without inventing a quote or workloads path', () => {
    expect(parsePlanPublish({ ...publish, quote: { id: 'forged' }, submit: true, path: '/api/v8/workloads' })).toEqual(publish)
  })

  it.each(['plan-1', 'plan_', '', 3])('rejects a non-host plan identity: %s', (id) => {
    expect(() => parsePlanPublish({ ...publish, id })).toThrow('INVALID_COMPUTE_FIELD: id')
  })
})

describe('compute quote JSON', () => {
  it('admits bounded metadata without adding payment or result claims', () => {
    const parsed = parseQuote({ ...quote, paid: true, resultAvailable: true, token: 'ignored-test-field' })
    expect(parsed).toEqual(quote)
    expectTypeOf(parsed.id).toEqualTypeOf<ComputeQuoteId>()
    expectTypeOf(parsed.planId).toEqualTypeOf<ComputePlanId>()
  })

  it('leaves freshness enforcement to the executor rather than the metadata parser', () => {
    const expiresAt = '2000-01-01T00:00:00.000Z'
    expect(parseQuote({ ...quote, expiresAt }).expiresAt).toBe(expiresAt)
  })

  it.each([0, 1, Number.MAX_SAFE_INTEGER])('preserves exact quote minor units: %s', (amountMinor) => {
    expect(parseQuote({ ...quote, amountMinor }).amountMinor).toBe(amountMinor)
  })

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '50', undefined])(
    'rejects an unsafe or inexact quote amount: %s',
    (amountMinor) => {
      expect(() => parseQuote({ ...quote, amountMinor })).toThrow('INVALID_COMPUTE_FIELD: amountMinor')
    },
  )

  it.each([
    '',
    'tomorrow',
    '2026-02-30T12:00:00.000Z',
    '2026-09-14T24:00:00.000Z',
    '2026-13-14T12:00:00.000Z',
    '2026-09-14',
    '2026-09-14T12:00:00.000',
    '2026-09-14T12:00:00.000Zsuffix',
    'x'.repeat(1000),
    1789387200000,
    undefined,
  ])('rejects an invalid or noncanonical expiry: %#', (expiresAt) => {
    expect(() => parseQuote({ ...quote, expiresAt })).toThrow('INVALID_COMPUTE_FIELD: expiresAt')
  })

  it('requires each quote field explicitly', () => {
    for (const key of Object.keys(quote)) {
      const omitted = Object.fromEntries(Object.entries(quote).filter(([field]) => field !== key))
      expect(() => parseQuote(omitted)).toThrow(`INVALID_COMPUTE_FIELD: ${key}`)
    }
  })

  it('rejects unsupported currency and invalid identities from a core response', () => {
    expect(() => parseQuote({ ...quote, currency: 'USD' })).toThrow('INVALID_COMPUTE_FIELD: currency')
    expect(() => parseQuote({ ...quote, id: 'q\n1' })).toThrow('INVALID_COMPUTE_FIELD: id')
    expect(() => parseQuote({ ...quote, planId: 'p'.repeat(MAX_COMPUTE_ID_CHARS + 1) })).toThrow('INVALID_COMPUTE_FIELD: planId')
    expect(() => parseQuote([])).toThrow('INVALID_COMPUTE_OBJECT')
  })
})

describe('owned compute identities', () => {
  it('preserves issued identifiers with distinct nominal types', () => {
    expect(ComputeCapabilityId('capability-1')).toBe('capability-1')
    expect(ComputePlanId('plan-1')).toBe('plan-1')
    expect(ComputeQuoteId('quote-1')).toBe('quote-1')
    const workloadId = ComputeWorkloadId('workload-1')
    expect(workloadId).toBe('workload-1')
    expectTypeOf(workloadId).toEqualTypeOf<ComputeWorkloadId>()
    expectTypeOf<ComputePlanId>().not.toEqualTypeOf<ComputeQuoteId>()
  })
})

describe('passive task envelope', () => {
  const task = {
    version: 'qianshou.task.v1', taskId: 'task-1', capabilityId: 'image.batch', capabilityVersion: '1.0.0',
    inputRefs: [{ name: 'input.png', bytes: 12, sha256: 'a'.repeat(64) }], parameters: { prompt: '夜景' },
    deadlineAt: '2026-09-14T12:00:00.000Z', maxOutputBytes: 1024, idempotencyKey: 'idem-1',
  }

  it('admits a versioned assignment with bounded JSON parameters', () => {
    const parsed = parseTaskEnvelope(task)
    expect(parsed).toMatchObject(task)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.parameters)).toBe(true)
    expect(Object.isFrozen(parsed.inputRefs[0])).toBe(true)
  })

  it.each([
    ['version', 'qianshou.task.v0'], ['deadlineAt', 'tomorrow'], ['maxOutputBytes', 0],
    ['inputRefs', [{ name: 'x', bytes: 1, sha256: 'bad' }]], ['parameters', { bad: undefined }],
  ] as const)('rejects malformed task field %s', (field, value) => {
    expect(() => parseTaskEnvelope({ ...task, [field]: value })).toThrow(`INVALID_COMPUTE_FIELD: ${field}`)
  })
})
