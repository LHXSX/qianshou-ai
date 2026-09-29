/** Server answers are projected field by field; a missing or mistyped field is never defaulted. */
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadContracts } from '../src/contract.ts'
import type { ContractSet } from '../src/contract.ts'
import { catalogOf, ESTIMATE_FIELDS, estimateOf, poolOf } from '../src/decode.ts'
import { CATALOG_RESPONSE } from './catalog-response.ts'

let contracts: ContractSet
beforeAll(async () => {
  contracts = await loadContracts(fileURLToPath(new URL('../../../../contracts/v1/', import.meta.url)))
})

const POOL = {
  found: true,
  capability: 'media.transcode',
  registry_version: '1.0',
  declared: { count: 3, by_impl: { ffmpeg: 3 } },
  available_now: { count: 1, by_impl: { ffmpeg: 1 }, online_ttl_seconds: 90 },
}

const ESTIMATE = {
  ok: true,
  task_type: 'video_compress',
  currency: 'CNY',
  estimated_total: '1.20',
  recommended_budget: '2.00',
  balance_enough: true,
  billing_mode: 'prepaid',
}

describe('catalog projection', () => {
  it('reads Shanghai registry fields and enriches only ids the local copy knows', () => {
    const decoded = catalogOf(CATALOG_RESPONSE, contracts)
    expect(decoded).toEqual({
      ok: true,
      value: {
        registryVersion: '1.0',
        entries: [
          { id: 'media.transcode', title: '音视频转码', taskType: 'video_compress' },
          { id: 'accelerator.gpu', title: 'GPU 加速器', taskType: null },
          { id: 'future.capability.added', title: null, taskType: null },
        ],
      },
    })
  })

  it('withholds a local estimate landing when Shanghai no longer lists that task type', () => {
    const decoded = catalogOf({ ...CATALOG_RESPONSE, capabilities: [
      { capability: 'media.transcode', implementations: ['ffmpeg'], legacy_task_types: [] },
    ] }, contracts)
    expect(decoded).toMatchObject({ ok: true, value: { entries: [{ id: 'media.transcode', taskType: null }] } })
  })

  it.each([
    ['a body that is not an object', []],
    ['the obsolete catalog format', { ok: true, registry_version: '1.0', items: [{ id: 'media.transcode' }] }],
    ['a missing registry version', { capabilities: [] }],
    ['capabilities that are not a list', { registry_version: '1.0', capabilities: {} }],
    ['an id outside the grammar', { ...CATALOG_RESPONSE, capabilities: [{ capability: 'Media', implementations: [], legacy_task_types: [] }] }],
    ['an item without an id', { ...CATALOG_RESPONSE, capabilities: [{ implementations: [], legacy_task_types: [] }] }],
    ['a duplicate id', { ...CATALOG_RESPONSE, capabilities: [CATALOG_RESPONSE.capabilities[0], CATALOG_RESPONSE.capabilities[0]] }],
    ['missing implementations', { ...CATALOG_RESPONSE, capabilities: [{ capability: 'media.transcode', legacy_task_types: ['video_compress'] }] }],
    ['invalid implementation', { ...CATALOG_RESPONSE, capabilities: [{ capability: 'media.transcode', implementations: [7], legacy_task_types: ['video_compress'] }] }],
    ['missing task types', { ...CATALOG_RESPONSE, capabilities: [{ capability: 'media.transcode', implementations: ['ffmpeg'] }] }],
    ['invalid task type', { ...CATALOG_RESPONSE, capabilities: [{ capability: 'media.transcode', implementations: ['ffmpeg'], legacy_task_types: ['../unsafe'] }] }],
    ['more capabilities than the bound accepts', { ...CATALOG_RESPONSE, capabilities: Array.from({ length: 5001 }, (_, index) => ({ capability: `custom.${index}`, implementations: [], legacy_task_types: [] })) }],
  ])('refuses %s', (_case, payload) => {
    expect(catalogOf(payload, contracts)).toEqual({ ok: false, failure: 'invalid-response' })
  })
})

describe('worker pool projection', () => {
  it('keeps declared and available-now as independent counts', () => {
    expect(poolOf(200, POOL, 'media.transcode')).toEqual({
      ok: true,
      value: {
        registryVersion: '1.0',
        declared: { count: 3, byImpl: { ffmpeg: 3 } },
        availableNow: { count: 1, byImpl: { ffmpeg: 1 }, onlineTtlSeconds: 90 },
      },
    })
  })

  it('reads a declared capability with nobody online as zero available, not as absent', () => {
    const decoded = poolOf(200, { ...POOL, available_now: { count: 0, by_impl: {}, online_ttl_seconds: 90 } }, 'media.transcode')
    expect(decoded).toMatchObject({ ok: true, value: { declared: { count: 3 }, availableNow: { count: 0, byImpl: {} } } })
  })

  it('reads the 404 body the capability routes use for an unknown name', () => {
    expect(poolOf(404, { detail: { found: false } }, 'media.transcode')).toEqual({ ok: false, failure: 'not-in-catalog' })
    expect(poolOf(404, { detail: {} }, 'media.transcode')).toEqual({ ok: false, failure: 'invalid-response' })
  })

  it.each([
    ['an answer for another capability', { ...POOL, capability: 'media.probe' }],
    ['a missing found flag', { ...POOL, found: undefined }],
    ['absent declared counts', { ...POOL, declared: undefined }],
    ['a fractional count', { ...POOL, declared: { count: 1.5, by_impl: {} } }],
    ['a negative count', { ...POOL, declared: { count: -1, by_impl: {} } }],
    ['a non-numeric implementation count', { ...POOL, declared: { count: 1, by_impl: { ffmpeg: 'many' } } }],
    ['a missing online ttl', { ...POOL, available_now: { count: 1, by_impl: {} } }],
  ])('refuses %s', (_case, payload) => {
    expect(poolOf(200, payload, 'media.transcode')).toEqual({ ok: false, failure: 'invalid-response' })
  })
})

describe('estimate projection', () => {
  it('copies every amount verbatim and publishes the server field behind each one', () => {
    expect(estimateOf(ESTIMATE, 'video_compress')).toEqual({
      ok: true,
      value: { currency: 'CNY', estimatedTotal: '1.20', recommendedBudget: '2.00', balanceEnough: true, billingMode: 'prepaid' },
    })
    expect(ESTIMATE_FIELDS).toMatchObject({ estimatedTotal: 'estimated_total', recommendedBudget: 'recommended_budget' })
  })

  it.each([
    ['an answer for another task type', { ...ESTIMATE, task_type: 'video_info' }],
    ['an amount sent as a number', { ...ESTIMATE, estimated_total: 1.2 }],
    ['an amount that is not a decimal', { ...ESTIMATE, recommended_budget: '2,00' }],
    ['a missing currency', { ...ESTIMATE, currency: '' }],
    ['a balance flag that is not a boolean', { ...ESTIMATE, balance_enough: 'yes' }],
    ['a missing billing mode', { ...ESTIMATE, billing_mode: undefined }],
    ['an answer that is not ok', { ...ESTIMATE, ok: false }],
  ])('refuses %s', (_case, payload) => {
    expect(estimateOf(payload, 'video_compress')).toEqual({ ok: false, failure: 'invalid-response' })
  })
})
