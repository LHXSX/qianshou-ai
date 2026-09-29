import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  CapabilitiesController, type CapabilitiesRead, type MarketRecordView, type MyCapability,
} from '../src/client/capabilities-controller.ts'
import type { PreflightReportView } from '../src/client/marketplace-controller.ts'

const GIB = 1024 ** 3

const WIZARD_STEPS = ['identity', 'run-preflight', 'order-policy', 'publish'] as const

function record(overrides: Partial<MarketRecordView> = {}): MarketRecordView {
  return {
    id: 'qianshou.article', capabilityId: 'text.transform', version: '1',
    installedAt: '2026-09-22T20:22:25.465Z', visibility: 'draft', inviteAccountIds: [], ...overrides,
  }
}

function capability(overrides: Partial<MyCapability> = {}): MyCapability {
  return {
    record: record(),
    title: '文章',
    summary: 'article',
    advertisable: true,
    metrics: {
      successRate: { state: 'unknown', reason: 'no-local-sample' },
      p95LatencyMs: { state: 'unknown', reason: 'no-local-sample' },
      vramBytes: { state: 'unknown', reason: 'not-probed' },
    },
    freeDiskBytes: 8 * GIB,
    totalMemoryBytes: 16 * GIB,
    ...overrides,
  }
}

function read(overrides: Partial<CapabilitiesRead> = {}): CapabilitiesRead {
  return {
    capabilities: [capability()],
    wizardSteps: [...WIZARD_STEPS],
    order: { mode: 'idle', maxConcurrency: 2 },
    ...overrides,
  }
}

function failed(): PreflightReportView {
  return {
    listingId: 'qianshou.article',
    steps: [
      { id: 'signature', state: 'passed', reason: '', detail: '' },
      { id: 'dependencies', state: 'failed', reason: 'DEPENDENCY_MISSING', detail: 'name=qianshou-extra' },
      { id: 'model', state: 'not-checked', reason: 'PENDING_EARLIER_STEP', detail: '' },
      { id: 'resources', state: 'not-checked', reason: 'PENDING_EARLIER_STEP', detail: '' },
    ],
    verdict: 'failed',
    failedStep: 'dependencies',
    actions: ['fix', 'recheck', 'cancel', 'rollback'],
  }
}

/** A host that answers the four methods 我的能力 uses, and nothing else. */
function controllerWith(remote: Record<string, unknown>): CapabilitiesController {
  return new CapabilitiesController({ remote: { qianshouPluginCatalog: remote } } as unknown as Context)
}

describe('我的能力 ownership', () => {
  it('rereads an open capability page after a market write that finished later', async () => {
    let resolveWrite: (() => void) | undefined
    const writing = new Promise<void>((resolve) => { resolveWrite = resolve })
    let saved: MyCapability[] = []
    const myCapabilities = vi.fn(() => Promise.resolve({ ok: true as const, value: read({ capabilities: saved }) }))
    const controller = controllerWith({ myCapabilities })
    const refresh = controller.refreshAfterMarketWrite(writing)
    await controller.reload()
    expect(controller.store.getSnapshot().capabilities).toEqual([])
    saved = [capability({ activity: 'active' })]
    resolveWrite?.()
    await refresh
    expect(myCapabilities).toHaveBeenCalledTimes(2)
    expect(controller.store.getSnapshot().capabilities.map(item => item.record.id)).toEqual(['qianshou.article'])
    controller.dispose()

    const closed = controllerWith({ myCapabilities })
    await closed.refreshAfterMarketWrite(Promise.resolve())
    expect(myCapabilities).toHaveBeenCalledTimes(2)
    closed.dispose()
  })

  it('does not query on creation and only reads once when the page is opened', async () => {
    const myCapabilities = vi.fn().mockResolvedValue({ ok: true, value: read() })
    const preflight = vi.fn()
    const saveCapabilityDraft = vi.fn()
    const publishCapability = vi.fn()
    const controller = controllerWith({ myCapabilities, preflight, saveCapabilityDraft, publishCapability })
    expect(controller.store.getSnapshot().loaded).toBe(false)
    controller.ensure(); controller.ensure()
    await vi.waitFor(() => { expect(controller.store.getSnapshot().loaded).toBe(true) })
    expect(myCapabilities).toHaveBeenCalledOnce()
    expect(preflight).not.toHaveBeenCalled()
    expect(saveCapabilityDraft).not.toHaveBeenCalled()
    expect(publishCapability).not.toHaveBeenCalled()
    const view = controller.store.getSnapshot()
    expect(view.wizardSteps).toEqual([...WIZARD_STEPS])
    expect(view.order).toEqual({ mode: 'idle', maxConcurrency: 2 })
    expect(view.capabilities[0]?.record.id).toBe('qianshou.article')
    controller.dispose()
  })

  it('does not show a stale or older Host row as publishable when activity cannot be established', async () => {
    const myCapabilities = vi.fn().mockResolvedValue({ ok: true, value: read({ capabilities: [
      capability({ activity: 'inactive', advertisable: true }),
      capability({ record: record({ id: 'qianshou.older' }), advertisable: true }),
    ] }) })
    const controller = controllerWith({ myCapabilities })
    await controller.reload()
    expect(controller.store.getSnapshot().capabilities.map(item => ({
      id: item.record.id, activity: item.activity, advertisable: item.advertisable,
    })))
      .toEqual([{ id: 'qianshou.article', activity: 'inactive', advertisable: false },
        { id: 'qianshou.older', activity: 'unknown', advertisable: false }])
    controller.dispose()
  })

  it('keeps every unmeasured number unknown rather than zero', async () => {
    const myCapabilities = vi.fn().mockResolvedValue({ ok: true, value: read() })
    const controller = controllerWith({ myCapabilities })
    await controller.reload()
    const metrics = controller.store.getSnapshot().capabilities[0]?.metrics
    expect(metrics?.successRate).toEqual({ state: 'unknown', reason: 'no-local-sample' })
    expect(metrics?.p95LatencyMs).toEqual({ state: 'unknown', reason: 'no-local-sample' })
    expect(metrics?.vramBytes).toEqual({ state: 'unknown', reason: 'not-probed' })
    expect(JSON.stringify(metrics)).not.toContain('"state":"measured"')
    controller.dispose()
  })

  it('reports an order policy the host did not load as unknown', async () => {
    const myCapabilities = vi.fn().mockResolvedValue({ ok: true, value: read({ order: null }) })
    const controller = controllerWith({ myCapabilities })
    await controller.reload()
    expect(controller.store.getSnapshot().order).toBeNull()
    controller.dispose()
  })

  it('writes only an explicit owner master switch and reads the committed mode back', async () => {
    const myCapabilities = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: read({ order: { mode: 'off', maxConcurrency: 2, enabledServiceCount: 0 } }) })
      .mockResolvedValue({ ok: true, value: read({ order: { mode: 'idle', maxConcurrency: 2, enabledServiceCount: 0 } }) })
    const setOwnerSupplyEnabled = vi.fn().mockResolvedValue({ ok: true, value: { mode: 'idle', maxConcurrency: 2, enabledServiceCount: 0 } })
    const controller = controllerWith({ myCapabilities, setOwnerSupplyEnabled })
    await controller.reload()
    expect(setOwnerSupplyEnabled).not.toHaveBeenCalled()
    await controller.setSupplyEnabled(true)
    expect(setOwnerSupplyEnabled).toHaveBeenCalledExactlyOnceWith({ enabled: true })
    expect(controller.store.getSnapshot()).toMatchObject({ order: { mode: 'idle', enabledServiceCount: 0 },
      busy: null, notice: { kind: 'supplySaved', enabled: true } })
    controller.dispose()
  })

  it('does not toggle when the Host policy is unknown', async () => {
    const myCapabilities = vi.fn().mockResolvedValue({ ok: true, value: read({ order: null }) })
    const setOwnerSupplyEnabled = vi.fn()
    const controller = controllerWith({ myCapabilities, setOwnerSupplyEnabled })
    await controller.reload()
    await controller.setSupplyEnabled(true)
    expect(setOwnerSupplyEnabled).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().error).toBe('errorSupplyUnavailable')
    controller.dispose()
  })

  it('opens the wizard on the first step the host named and seeds the invite field from the saved list', async () => {
    const myCapabilities = vi.fn().mockResolvedValue({
      ok: true, value: read({ capabilities: [capability({ record: record({ inviteAccountIds: ['12', '34'] }) })] }),
    })
    const controller = controllerWith({ myCapabilities })
    await controller.reload()
    expect(controller.store.getSnapshot().selectedId).toBeNull()
    controller.open('qianshou.article')
    expect(controller.store.getSnapshot()).toMatchObject({
      selectedId: 'qianshou.article', step: 'identity', visibility: 'draft', confirmed: false, inviteText: '12\n34', report: null,
    })
    controller.close()
    expect(controller.store.getSnapshot()).toMatchObject({ selectedId: null, step: null, confirmed: false })
    controller.dispose()
  })

  it('saves a draft with the invited accounts and no visibility of its own', async () => {
    const myCapabilities = vi.fn().mockResolvedValue({ ok: true, value: read() })
    const saveCapabilityDraft = vi.fn().mockResolvedValue({ ok: true, value: record() })
    const publishCapability = vi.fn()
    const controller = controllerWith({ myCapabilities, saveCapabilityDraft, publishCapability })
    await controller.reload()
    controller.open('qianshou.article')
    controller.editInvite(' 12 \n34\n12\n\n')
    await controller.saveDraft('qianshou.article')
    expect(saveCapabilityDraft).toHaveBeenCalledExactlyOnceWith({ id: 'qianshou.article', inviteAccountIds: ['12', '34'] })
    expect(publishCapability).not.toHaveBeenCalled()
    const view = controller.store.getSnapshot()
    expect(view.notice).toEqual({ kind: 'draftSaved' })
    expect(view.busy).toBeNull()
    expect(view.error).toBeNull()
    // A saved row is read back, so the page shows the visibility and the list this computer now holds.
    expect(myCapabilities).toHaveBeenCalledTimes(2)
    expect(view.visibility).toBe('draft')
    controller.dispose()
  })

  it('publishes public only after the owner confirmed the public choice', async () => {
    // The host writes the published row, so the read that follows reports the new visibility.
    const myCapabilities = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: read() })
      .mockResolvedValue({ ok: true, value: read({ capabilities: [capability({ record: record({ visibility: 'public' }) })] }) })
    const publishCapability = vi.fn().mockResolvedValue({ ok: true, value: record({ visibility: 'public' }) })
    const controller = controllerWith({ myCapabilities, publishCapability })
    await controller.reload()
    controller.open('qianshou.article')
    controller.selectVisibility('public')
    await controller.publish('qianshou.article')
    expect(publishCapability).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().error).toBe('errorPublishUnconfirmed')
    // A confirmation belongs to the choice it was given for: changing the visibility clears it.
    controller.confirmPublic(true)
    expect(controller.store.getSnapshot().confirmed).toBe(true)
    controller.selectVisibility('private')
    expect(controller.store.getSnapshot().confirmed).toBe(false)
    controller.selectVisibility('public')
    controller.confirmPublic(true)
    await controller.publish('qianshou.article')
    expect(publishCapability).toHaveBeenCalledExactlyOnceWith({
      id: 'qianshou.article', visibility: 'public', confirmPublic: true,
    })
    expect(controller.store.getSnapshot().notice).toEqual({ kind: 'published', visibility: 'public' })
    expect(controller.store.getSnapshot().confirmed).toBe(false)
    expect(controller.store.getSnapshot().visibility).toBe('public')
    controller.dispose()
  })

  it('stores the invited accounts on this computer before publishing an invited capability', async () => {
    const calls: string[] = []
    const myCapabilities = vi.fn().mockResolvedValue({ ok: true, value: read() })
    const saveCapabilityDraft = vi.fn().mockImplementation(() => {
      calls.push('draft')
      return Promise.resolve({ ok: true, value: record({ visibility: 'draft', inviteAccountIds: ['77'] }) })
    })
    const publishCapability = vi.fn().mockImplementation(() => {
      calls.push('publish')
      return Promise.resolve({ ok: true, value: record({ visibility: 'invite', inviteAccountIds: ['77'] }) })
    })
    const controller = controllerWith({ myCapabilities, saveCapabilityDraft, publishCapability })
    await controller.reload()
    controller.open('qianshou.article')
    controller.selectVisibility('invite')
    controller.editInvite('77')
    await controller.publish('qianshou.article')
    expect(calls).toEqual(['draft', 'publish'])
    expect(saveCapabilityDraft).toHaveBeenCalledExactlyOnceWith({ id: 'qianshou.article', inviteAccountIds: ['77'] })
    expect(publishCapability).toHaveBeenCalledExactlyOnceWith({
      id: 'qianshou.article', visibility: 'invite', confirmPublic: false,
    })
    expect(controller.store.getSnapshot().notice).toEqual({ kind: 'published', visibility: 'invite' })
    controller.dispose()
  })

  it('words a stable host code instead of the message the host sent', async () => {
    const myCapabilities = vi.fn().mockResolvedValue({ ok: true, value: read() })
    const saveCapabilityDraft = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { message: 'QIANSHOU_CATALOG_invalid-invite' } })
      .mockResolvedValueOnce({ ok: false, error: { message: 'QIANSHOU_CATALOG_something-new' } })
    const controller = controllerWith({ myCapabilities, saveCapabilityDraft })
    await controller.reload()
    await controller.saveDraft('qianshou.article')
    expect(controller.store.getSnapshot().error).toBe('errorInvalidInvite')
    expect(controller.store.getSnapshot().busy).toBeNull()
    expect(myCapabilities).toHaveBeenCalledOnce()
    await controller.saveDraft('qianshou.article')
    expect(controller.store.getSnapshot().error).toBe('errorGeneric')
    controller.dispose()
  })

  it('words a refused publish on a capability this computer cannot accept', async () => {
    const myCapabilities = vi.fn().mockResolvedValue({
      ok: true, value: read({ capabilities: [capability({ advertisable: false })] }),
    })
    const publishCapability = vi.fn().mockResolvedValue({ ok: false, error: { message: 'QIANSHOU_CATALOG_not-advertisable' } })
    const controller = controllerWith({ myCapabilities, publishCapability })
    await controller.reload()
    controller.open('qianshou.article')
    await controller.publish('qianshou.article')
    expect(publishCapability).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().error).toBe('errorNotAdvertisable')
    controller.dispose()
  })

  it('runs the checks and keeps the report the host produced', async () => {
    const myCapabilities = vi.fn().mockResolvedValue({ ok: true, value: read() })
    const preflight = vi.fn().mockResolvedValue({ ok: true, value: failed() })
    const controller = controllerWith({ myCapabilities, preflight })
    await controller.reload()
    controller.open('qianshou.article')
    await controller.runPreflight('qianshou.article')
    expect(preflight).toHaveBeenCalledExactlyOnceWith({ id: 'qianshou.article' })
    const view = controller.store.getSnapshot()
    expect(view.report?.failedStep).toBe('dependencies')
    expect(view.report?.steps.map(step => step.state)).toEqual(['passed', 'failed', 'not-checked', 'not-checked'])
    expect(view.busy).toBeNull()
    controller.dispose()
  })

  it('closes the wizard when the capability it was opened on leaves the list', async () => {
    const myCapabilities = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: read() })
      .mockResolvedValueOnce({ ok: true, value: read({ capabilities: [] }) })
    const controller = controllerWith({ myCapabilities })
    await controller.reload()
    controller.open('qianshou.article')
    await controller.reload()
    const view = controller.store.getSnapshot()
    expect(view.capabilities).toHaveLength(0)
    expect(view.selectedId).toBeNull()
    expect(view.step).toBeNull()
    controller.dispose()
  })

  it('keeps the rows it read while another read is in flight', async () => {
    const second = capability({ record: record({ id: 'qianshou.image', capabilityId: 'image.generate' }) })
    const myCapabilities = vi.fn().mockResolvedValueOnce({ ok: true, value: read() })
    const controller = controllerWith({ myCapabilities })
    await controller.reload()
    const late = Promise.withResolvers<{ ok: true; value: CapabilitiesRead }>()
    myCapabilities.mockReturnValueOnce(late.promise)
    const pending = controller.reload()
    const loading = controller.store.getSnapshot()
    expect(loading).toMatchObject({ loading: true, loaded: true })
    expect(loading.capabilities.map(item => item.record.id)).toEqual(['qianshou.article'])
    late.resolve({ ok: true, value: read({ capabilities: [capability(), second] }) })
    await pending
    expect(controller.store.getSnapshot()).toMatchObject({ loading: false })
    expect(controller.store.getSnapshot().capabilities.map(item => item.record.id))
      .toEqual(['qianshou.article', 'qianshou.image'])
    controller.dispose()
  })

  it('ignores a late response after the plugin unloads', async () => {
    const late = Promise.withResolvers<{ ok: true; value: CapabilitiesRead }>()
    const myCapabilities = vi.fn().mockReturnValue(late.promise)
    const controller = controllerWith({ myCapabilities })
    const pending = controller.reload()
    controller.dispose()
    const before = controller.store.getSnapshot()
    late.resolve({ ok: true, value: read() })
    await pending
    expect(controller.store.getSnapshot()).toBe(before)
  })
})
