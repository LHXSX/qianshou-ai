import { describe, expect, it, vi } from 'vitest'
import { createIntakeSupplyTransport, type IntakeSupplyRemote } from '../src/client/node-status/supply-transport.ts'

describe('intake owner policy remote', () => {
  it('reads the policy without waiting for the market-backed capability summary', async () => {
    const myCapabilities = vi.fn(async () => { throw new Error('market discovery must not run') })
    const myOrderPolicy = vi.fn(async () => ({ ok: true as const, value: {
      mode: 'idle', maxConcurrency: 2, enabledServiceCount: 1, enabledServiceIds: ['node'],
    } }))
    const supply = createIntakeSupplyTransport({ myCapabilities, myOrderPolicy,
      orderSources: async () => ({ ok: true, value: { sources: [], complete: true } }),
      setOwnerSupplyEnabled: async () => { throw new Error('unexpected write') },
      setLocalServiceEnabled: async () => { throw new Error('unexpected write') } })
    expect(await supply.read()).toMatchObject({ mode: 'idle', enabledServiceIds: ['node'] })
    expect(myOrderPolicy).toHaveBeenCalledTimes(1)
    expect(myCapabilities).not.toHaveBeenCalled()
    myOrderPolicy.mockResolvedValueOnce({ ok: true, value: null } as never)
    expect(await supply.read()).toBeNull()
  })

  it('falls back only when the older Host explicitly lacks the Remote method', async () => {
    const myCapabilities = vi.fn(async () => ({ ok: true as const, value: { order: {
      mode: 'off', maxConcurrency: 2, enabledServiceCount: 0, enabledServiceIds: [],
    } } }))
    const myOrderPolicy = vi.fn(async () => ({ ok: false as const, error: {
      code: 'gateway/invocation-unavailable', message: 'no active Remote method exports this endpoint',
    } }))
    const supply = createIntakeSupplyTransport({ myCapabilities, myOrderPolicy,
      orderSources: async () => ({ ok: true, value: { sources: [], complete: true } }),
      setOwnerSupplyEnabled: async () => { throw new Error('unexpected write') },
      setLocalServiceEnabled: async () => { throw new Error('unexpected write') } })
    expect(await supply.read()).toMatchObject({ mode: 'off', enabledServiceIds: [] })
    expect(myCapabilities).toHaveBeenCalledTimes(1)
    for (const code of ['gateway/service-unavailable', 'gateway/timeout', 'account/auth-required']) {
      myOrderPolicy.mockResolvedValueOnce({ ok: false, error: { code, message: 'unavailable' } })
      await expect(supply.read()).rejects.toThrow('unavailable')
    }
    expect(myCapabilities).toHaveBeenCalledTimes(1)
  })

  it('preserves separate approval and listing facts, with no price-derived device grant', async () => {
    const row = { id: 'skill:user-dsh:paper-helper', kind: 'skill', source: 'user-dsh', title: '文档助手', description: '',
      category: 'text', loadState: 'unknown', capabilityId: null, taskType: 'paper_check_v1', serviceId: null,
      selectable: false, eligible: false, enabled: false, reason: 'publication-approved',
      authorPublication: { publicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'approved',
        archiveConfirmed: true, listingStatus: 'not-listed', salePriceYuan: null } }
    const write = vi.fn(async () => ({ ok: false as const, error: { message: 'unused' } }))
    const transport = createIntakeSupplyTransport({
      myCapabilities: async () => ({ ok: true, value: { order: null } }),
      orderSources: async () => ({ ok: true, value: { sources: [row], complete: true } }),
      setOwnerSupplyEnabled: write, setLocalServiceEnabled: write,
    })
    expect((await transport.listSources?.())?.sources[0]).toMatchObject({ eligible: false, enabled: false,
      authorPublication: { status: 'approved', listingStatus: 'not-listed', salePriceYuan: null } })
    expect(write).not.toHaveBeenCalled()
    for (const change of [{ salePriceYuan: 0.5 }, { salePriceYuan: '0.5' }, { listingStatus: 'ready' },
      { publicationId: 'not-an-id' }, { archiveConfirmed: 'true' }, { privateToken: 'not allowed' }]) {
      const original = row.authorPublication
      row.authorPublication = { ...original, ...change } as typeof original
      await expect(transport.listSources?.()).rejects.toThrow('INVALID_ORDER_SOURCES')
      row.authorPublication = original
    }
    Object.assign(row, { authorProductId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
    await expect(transport.listSources?.()).rejects.toThrow('INVALID_ORDER_SOURCES')
  })

  it('enables the exact author source through the Host and accepts only a committed device and grant', async () => {
    const activateAuthorOrderSkill = vi.fn(async () => ({ ok: true as const, value: {
      source: 'user-agents', name: 'char-counter', productId: 'b9418e38-b3a5-5722-8005-cc7afbe2a21a',
      publicationId: '3a491d7e-31b5-4d0b-aa43-76d27f3c9a7b',
      deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', runtimeDigest: `sha256:${'a'.repeat(64)}`,
      deviceInstalled: true, dispatchEligible: true,
      order: { mode: 'idle', maxConcurrency: 1, enabledServiceCount: 1, enabledServiceIds: ['node'] },
    } }))
    const supply = createIntakeSupplyTransport({ myCapabilities: async () => ({ ok: true, value: { order: null } }),
      orderSources: async () => ({ ok: true, value: { sources: [], complete: true } }), activateAuthorOrderSkill,
      setOwnerSupplyEnabled: async () => { throw new Error('the Host owns the bounded enable action') },
      setLocalServiceEnabled: async () => { throw new Error('the Host owns the bounded enable action') } })
    expect(await supply.activateAuthorSource?.('skill:user-agents:char-counter')).toMatchObject({ mode: 'idle', enabledServiceIds: ['node'] })
    expect(activateAuthorOrderSkill).toHaveBeenCalledExactlyOnceWith({ source: 'user-agents', name: 'char-counter' })
    await expect(supply.activateAuthorSource?.('bundle:char-counter')).rejects.toThrow('INVALID_AUTHOR_ORDER_SOURCE')
    activateAuthorOrderSkill.mockResolvedValueOnce({ ok: true, value: { ...(await activateAuthorOrderSkill()).value,
      source: 'user-dsh' } })
    await expect(supply.activateAuthorSource?.('skill:user-agents:char-counter')).rejects.toThrow('INVALID_AUTHOR_ORDER_ACTIVATION')
  })

  it('allows multiple device-backed authored tasks sharing one coherent node grant and rejects an unproven skill', async () => {
    const common = { title: '统计', description: '', category: 'text', loadState: 'active', capabilityId: 'text.char_counter',
      taskType: 'char_counter_v1', serviceId: 'node', selectable: false, eligible: true, enabled: true, reason: 'ready' }
    const rows = [{ ...common, id: 'builtin:word_count', kind: 'builtin', source: 'builtin' },
      { ...common, id: 'skill:user-agents:char-counter', kind: 'skill', source: 'user-agents',
        authorProductId: 'b9418e38-b3a5-5722-8005-cc7afbe2a21a' }]
    const remote: IntakeSupplyRemote = { myCapabilities: async () => ({ ok: true, value: { order: null } }),
      orderSources: async () => ({ ok: true, value: { sources: rows, complete: true } }),
      setOwnerSupplyEnabled: async () => ({ ok: false, error: { message: 'unused' } }),
      setLocalServiceEnabled: async () => ({ ok: false, error: { message: 'unused' } }) }
    const supply = createIntakeSupplyTransport(remote)
    expect((await supply.listSources?.())?.sources).toHaveLength(2)
    delete (rows[1] as { authorProductId?: string }).authorProductId
    await expect(supply.listSources?.()).rejects.toThrow('INVALID_ORDER_SOURCES')
  })

  it('reads and writes the Host policy without treating local admission as a process switch', async () => {
    const setOwnerSupplyEnabled = vi.fn(async () => ({ ok: true as const,
      value: { mode: 'idle', maxConcurrency: 2, enabledServiceCount: 0, enabledServiceIds: [] } }))
    const setLocalServiceEnabled = vi.fn(async () => ({ ok: true as const,
      value: { mode: 'idle', maxConcurrency: 2, enabledServiceCount: 1, enabledServiceIds: ['node'] } }))
    const remote: IntakeSupplyRemote = {
      orderSources: async () => ({ ok: true, value: { sources: [], complete: true, order: null } }),
      myCapabilities: async () => ({ ok: true, value: { order: { mode: 'off', maxConcurrency: 2,
        enabledServiceCount: 0, enabledServiceIds: [] }, capabilities: [] } }),
      setOwnerSupplyEnabled,
      setLocalServiceEnabled,
    }
    const supply = createIntakeSupplyTransport(remote)
    expect(await supply.read()).toEqual({ mode: 'off', maxConcurrency: 2, enabledServiceCount: 0, enabledServiceIds: [] })
    expect(await supply.set(true)).toEqual({ mode: 'idle', maxConcurrency: 2, enabledServiceCount: 0, enabledServiceIds: [] })
    expect(setOwnerSupplyEnabled).toHaveBeenCalledExactlyOnceWith({ enabled: true })
    expect(await supply.setTextService(true)).toEqual({ mode: 'idle', maxConcurrency: 2,
      enabledServiceCount: 1, enabledServiceIds: ['node'] })
    expect(setLocalServiceEnabled).toHaveBeenCalledExactlyOnceWith({ serviceId: 'node', enabled: true })
  })

  it('does not convert unavailable or malformed policy into an enabled switch', async () => {
    const missing = createIntakeSupplyTransport({
      orderSources: async () => ({ ok: false, error: { message: 'inventory-unavailable' } }),
      myCapabilities: async () => ({ ok: true, value: { order: null } }),
      setOwnerSupplyEnabled: async () => ({ ok: false, error: { message: 'supply-unavailable' } }),
      setLocalServiceEnabled: async () => ({ ok: false, error: { message: 'service-unavailable' } }),
    })
    expect(await missing.read()).toBeNull()
    await expect(missing.set(true)).rejects.toThrow('supply-unavailable')
    await expect(missing.setTextService(true)).rejects.toThrow('service-unavailable')
    const invalid = createIntakeSupplyTransport({
      orderSources: async () => ({ ok: true, value: { sources: [{ id: 'x' }], complete: true } }),
      myCapabilities: async () => ({ ok: true, value: { order: { mode: 'always', maxConcurrency: 2 } } }),
      setOwnerSupplyEnabled: async () => ({ ok: true, value: null }),
      setLocalServiceEnabled: async () => ({ ok: true, value: { mode: 'idle', maxConcurrency: 2,
        enabledServiceCount: 1 } }),
    })
    await expect(invalid.read()).rejects.toThrow('INVALID_SUPPLY_POLICY')
    await expect(invalid.listSources?.()).rejects.toThrow('INVALID_ORDER_SOURCES')
    await expect(invalid.setTextService(true)).rejects.toThrow('INVALID_SUPPLY_POLICY')
  })

  it('does not infer the word_count grant from the count of other services', async () => {
    const remote: IntakeSupplyRemote = {
      orderSources: async () => ({ ok: true, value: { sources: [], complete: true, order: null } }),
      myCapabilities: async () => ({ ok: true, value: { order: { mode: 'idle', maxConcurrency: 1,
        enabledServiceCount: 1, enabledServiceIds: ['git'] } } }),
      setOwnerSupplyEnabled: async () => ({ ok: false, error: { message: 'unexpected' } }),
      setLocalServiceEnabled: async () => ({ ok: false, error: { message: 'unexpected' } }),
    }
    expect(await createIntakeSupplyTransport(remote).read()).toEqual({ mode: 'idle', maxConcurrency: 1,
      enabledServiceCount: 1, enabledServiceIds: ['git'] })
  })

  it('passes an exact installed source id to the Host without granting service access', async () => {
    const setLocalServiceEnabled = vi.fn(async () => ({ ok: false as const, error: { message: 'unexpected grant' } }))
    const selectOrderSource = vi.fn(async () => ({ ok: true as const, value: {
      selectedSourceId: 'bundle:%40author%2Fwordfreq', taskType: 'word_count',
      capabilityId: 'text.transform', requiresGrant: true,
    } }))
    const supply = createIntakeSupplyTransport({
      myCapabilities: async () => ({ ok: true, value: { order: null } }),
      orderSources: async () => ({ ok: true, value: { sources: [], complete: true, order: null } }),
      setOwnerSupplyEnabled: async () => ({ ok: false, error: { message: 'unexpected master toggle' } }),
      setLocalServiceEnabled, selectOrderSource,
    })
    expect(await supply.selectSource?.('bundle:%40author%2Fwordfreq')).toEqual({
      selectedSourceId: 'bundle:%40author%2Fwordfreq', taskType: 'word_count',
      capabilityId: 'text.transform', requiresGrant: true,
    })
    expect(selectOrderSource).toHaveBeenCalledExactlyOnceWith({ sourceId: 'bundle:%40author%2Fwordfreq' })
    expect(setLocalServiceEnabled).not.toHaveBeenCalled()
  })

  it('accepts a verified non-word-count task selection without granting it implicitly', async () => {
    const setLocalServiceEnabled = vi.fn()
    const supply = createIntakeSupplyTransport({
      myCapabilities: async () => ({ ok: true, value: { order: null } }),
      orderSources: async () => ({ ok: true, value: { sources: [], complete: true, order: null } }),
      setOwnerSupplyEnabled: async () => ({ ok: false, error: { message: 'unexpected' } }),
      setLocalServiceEnabled,
      selectOrderSource: async () => ({ ok: true, value: {
        selectedSourceId: 'bundle:sorter', taskType: 'text_sort', capabilityId: 'text.transform', requiresGrant: true,
      } }),
    })
    expect(await supply.selectSource?.('bundle:sorter')).toEqual({
      selectedSourceId: 'bundle:sorter', taskType: 'text_sort', capabilityId: 'text.transform', requiresGrant: true,
    })
    expect(setLocalServiceEnabled).not.toHaveBeenCalled()
  })
})
