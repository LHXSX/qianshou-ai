/**
 * Draft editing rules: complete-policy submission, Host-parity validation, and
 * the capability rows that keep enabled-but-not-discovered identifiers visible.
 */
import { describe, expect, it } from 'vitest'
import {
  MIB, draftMemoryBytes, memoryFacts, memoryPlaceholder, policyForm, policyRequest, serviceRows,
} from '../src/client/form.ts'
import { blockedJson, emptyJson, snapshot } from './fixtures.client.ts'

const observed = snapshot()

describe('owner policy draft', () => {
  it('seeds every editable field and leaves the memory override blank', () => {
    expect(policyForm(observed)).toEqual({
      mode: 'idle', maxConcurrency: '2', minFreeMemoryMiB: '', minIdleSeconds: '300', enabledServiceIds: ['tool-ffmpeg'],
    })
  })

  it('resolves the memory floor exactly, and refuses a value the Host would reject', () => {
    const form = policyForm(observed)
    expect(draftMemoryBytes(form, 4294967296)).toBe(4294967296)
    expect(draftMemoryBytes({ ...form, minFreeMemoryMiB: '  512 ' }, 1)).toBe(512 * MIB)
    expect(draftMemoryBytes({ ...form, minFreeMemoryMiB: '0' }, 1)).toBe(0)
    expect(draftMemoryBytes({ ...form, minFreeMemoryMiB: '1.5' }, 1)).toBeNull()
    expect(draftMemoryBytes({ ...form, minFreeMemoryMiB: '-1' }, 1)).toBeNull()
    expect(draftMemoryBytes({ ...form, minFreeMemoryMiB: 'abc' }, 1)).toBeNull()
    expect(draftMemoryBytes({ ...form, minFreeMemoryMiB: '9007199254740992' }, 1)).toBeNull()
  })

  it('never suggests a rounded memory hint', () => {
    expect(memoryPlaceholder(4294967296)).toBe('4096 MiB')
    expect(memoryPlaceholder(1000000)).toBe('1000000 B')
    expect(memoryFacts(4294967296)).toEqual({ bytes: 4294967296, size: '4.0GB' })
  })

  it('submits the complete policy, echoing the rate settings this page does not edit', () => {
    const request = policyRequest({ ...policyForm(observed), mode: 'allowed', maxConcurrency: '4', minFreeMemoryMiB: '1024' }, observed)
    expect(request).toEqual({
      ok: true,
      policy: {
        mode: 'allowed', maxConcurrency: 4, minFreeMemoryBytes: 1024 * MIB, minIdleSeconds: 300,
        enabledServiceIds: ['tool-ffmpeg'],
        nodeRates: [{ localServiceId: 'tool-ffmpeg', amountMinor: 250, unit: 'per-image', currency: 'CNY' }],
      },
    })
  })

  it.each([
    ['mode', { mode: 'sometimes' as never }, 'mode'],
    ['maxConcurrency zero', { maxConcurrency: '0' }, 'maxConcurrency'],
    ['maxConcurrency blank', { maxConcurrency: ' ' }, 'maxConcurrency'],
    ['maxConcurrency fraction', { maxConcurrency: '2.5' }, 'maxConcurrency'],
    ['maxConcurrency overflow', { maxConcurrency: '9007199254740992' }, 'maxConcurrency'],
    ['minIdleSeconds negative', { minIdleSeconds: '-1' }, 'minIdleSeconds'],
    ['minIdleSeconds blank', { minIdleSeconds: '' }, 'minIdleSeconds'],
    ['minIdleSeconds overflow', { minIdleSeconds: '9007199254740993' }, 'minIdleSeconds'],
    ['memory floor', { minFreeMemoryMiB: '1.5' }, 'minFreeMemory'],
  ])('reports the %s problem without inventing a policy', (_case, patch, kind) => {
    const request = policyRequest({ ...policyForm(observed), ...patch }, observed)
    expect(request.ok).toBe(false)
    expect(request.ok ? null : request.problem.kind).toBe(kind)
  })

  it('blocks a save that would drop or break an enabled identifier', () => {
    const form = policyForm(observed)
    const tooMany = policyRequest({ ...form, enabledServiceIds: Array.from({ length: 129 }, (_, index) => `tool-${index}`) }, observed)
    expect(tooMany.ok).toBe(false)
    expect(tooMany.ok ? null : tooMany.problem.kind).toBe('serviceIdLimit')
    const bad = policyRequest({ ...form, enabledServiceIds: ['tool ffmpeg'] }, observed)
    expect(bad).toEqual({ ok: false, problem: { kind: 'serviceId', id: 'tool ffmpeg' } })
    const duplicated = policyRequest({ ...form, enabledServiceIds: ['tool-ffmpeg', 'tool-ffmpeg'] }, observed)
    expect(duplicated).toEqual({ ok: false, problem: { kind: 'serviceId', id: 'tool-ffmpeg' } })
  })

  it('accepts the empty capability list and the empty rate list', () => {
    const empty = snapshot({ ...emptyJson, ownerPolicy: { ...emptyJson.ownerPolicy, mode: 'off' }, eligibility: { state: 'disabled', reasons: ['OWNER_DISABLED'] } })
    const request = policyRequest(policyForm(empty), empty)
    expect(request.ok && request.policy.enabledServiceIds).toEqual([])
    expect(request.ok && request.policy.nodeRates).toEqual([])
  })
})

describe('capability rows', () => {
  it('lists discovered services in observation order with their self-check verdict', () => {
    const rows = serviceRows(observed, null)
    expect(rows.map(row => row.id)).toEqual(['tool-ffmpeg', 'ollama:abc'])
    expect(rows[0]).toMatchObject({ name: 'ffmpeg', kind: 'tool', verification: 'verified', enabled: true, acceptable: true })
    expect(rows[1]).toMatchObject({ verification: 'pending', enabled: false, reason: 'MODEL_INFERENCE_NOT_VERIFIED' })
  })

  it('keeps an enabled identifier that this observation no longer discovers', () => {
    const form = { ...policyForm(observed), enabledServiceIds: ['tool-ffmpeg', 'tool-retired'] }
    const rows = serviceRows(observed, form)
    expect(rows.map(row => row.id)).toEqual(['tool-ffmpeg', 'ollama:abc', 'tool-retired'])
    expect(rows[2]).toEqual({
      id: 'tool-retired', name: null, kind: null, version: null, verification: null, reason: null, enabled: true, acceptable: true,
    })
  })

  it('flags an identifier the Host parser would reject', () => {
    const form = { ...policyForm(observed), enabledServiceIds: ['tool-ffmpeg', 'not an id', 'tool-retired'] }
    const rows = serviceRows(observed, form)
    expect(rows.find(row => row.id === 'not an id')?.acceptable).toBe(false)
    expect(rows.find(row => row.id === 'tool-ffmpeg')?.acceptable).toBe(true)
  })

  it('renders an empty inventory as an empty row list', () => {
    expect(serviceRows(snapshot({ ...emptyJson, ownerPolicy: { ...emptyJson.ownerPolicy, mode: 'off' }, eligibility: { state: 'disabled', reasons: ['OWNER_DISABLED'] } }), null)).toEqual([])
    expect(serviceRows(null, null)).toEqual([])
    expect(serviceRows(null, { mode: 'off', maxConcurrency: '1', minFreeMemoryMiB: '', minIdleSeconds: '0', enabledServiceIds: ['tool-x'] })[0]?.enabled).toBe(true)
  })

  it('reflects a draft toggle instead of the observed policy', () => {
    const form = { ...policyForm(observed), enabledServiceIds: [] as string[] }
    expect(serviceRows(observed, form).every(row => !row.enabled)).toBe(true)
    expect(blockedJson.ownerPolicy.enabledServiceIds).toEqual(['tool-ffmpeg'])
  })
})
