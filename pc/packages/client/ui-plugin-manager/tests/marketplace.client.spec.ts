import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { MarketplaceController, type PreflightReportView } from '../src/client/marketplace-controller.ts'

function catalog(mode: 'shipped' | 'api' = 'shipped') {
  return {
    mode,
    source: mode === 'api' ? 'https://market.example' : 'shipped',
    listings: [{
      id: 'qianshou.article', title: '文章', summary: 'article', capabilityId: 'text.transform',
      version: '1', installable: true,
    }],
  }
}

function report(overrides: Partial<PreflightReportView> = {}): PreflightReportView {
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
    ...overrides,
  }
}

function passed(): PreflightReportView {
  return {
    listingId: 'qianshou.article',
    steps: [
      { id: 'signature', state: 'passed', reason: '', detail: '' },
      { id: 'dependencies', state: 'passed', reason: '', detail: '' },
      { id: 'model', state: 'passed', reason: '', detail: '' },
      { id: 'resources', state: 'passed', reason: '', detail: '' },
    ],
    verdict: 'passed',
    failedStep: null,
    actions: [],
  }
}

function controllerWith(market: Record<string, unknown>): MarketplaceController {
  return new MarketplaceController({ remote: { qianshouPluginCatalog: market } } as unknown as Context)
}

describe('plugin market ownership', () => {
  it('does not query on creation and only loads once when opened', async () => {
    const listings = vi.fn().mockResolvedValue({ ok: true, value: catalog() })
    const installed = vi.fn().mockResolvedValue({ ok: true, value: { records: [] } })
    const installListing = vi.fn()
    const controller = controllerWith({ listings, installed, installListing })
    controller.ensure(); controller.ensure()
    await vi.waitFor(() => { expect(controller.store.getSnapshot().listings[0]?.id).toBe('qianshou.article') })
    expect(listings).toHaveBeenCalledOnce()
    expect(installed).toHaveBeenCalledOnce()
    expect(installListing).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().mode).toBe('shipped')
    controller.dispose()
  })

  it('checks the listing first, then installs it and shows it as installed', async () => {
    const listings = vi.fn().mockResolvedValue({ ok: true, value: catalog() })
    const installed = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { records: [] } })
      .mockResolvedValueOnce({ ok: true, value: { records: [{ id: 'qianshou.article', version: '1', capabilityId: 'text.transform' }] } })
    const preflight = vi.fn().mockResolvedValue({ ok: true, value: passed() })
    const installListing = vi.fn().mockResolvedValue({ ok: true, value: { id: 'qianshou.article' } })
    const controller = controllerWith({ listings, installed, installListing, preflight })
    await controller.reload()
    await controller.install('qianshou.article')
    expect(preflight).toHaveBeenCalledExactlyOnceWith({ id: 'qianshou.article' })
    expect(installListing).toHaveBeenCalledExactlyOnceWith({ id: 'qianshou.article' })
    expect(controller.store.getSnapshot().installedRecords).toEqual([{
      id: 'qianshou.article', version: '1', capabilityId: 'text.transform',
    }])
    expect(controller.store.getSnapshot().busyId).toBeNull()
    expect(controller.store.getSnapshot().report?.verdict).toBe('passed')
    controller.dispose()
  })

  it('keeps a package awaiting restart out of the saved market records', async () => {
    const installed = vi.fn().mockResolvedValue({ ok: true, value: { records: [] } })
    const controller = controllerWith({
      listings: vi.fn().mockResolvedValue({ ok: true, value: catalog() }), installed,
      preflight: vi.fn().mockResolvedValue({ ok: true, value: passed() }),
      installListing: vi.fn().mockResolvedValue({ ok: false, error: { message: 'QIANSHOU_CATALOG_activation-pending' } }),
    })
    await controller.reload()
    await controller.install('qianshou.article')
    expect(controller.store.getSnapshot()).toMatchObject({ error: 'activationPending', installedRecords: [], busyId: null })
    expect(installed).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('keeps a saved declaration when its listing is absent from the current catalog', async () => {
    const record = { id: 'old.article', version: '1', capabilityId: 'text.transform' }
    const controller = controllerWith({
      listings: vi.fn().mockResolvedValue({ ok: true, value: { ...catalog('api'), listings: [] } }),
      installed: vi.fn().mockResolvedValue({ ok: true, value: { records: [record] } }),
    })
    await controller.reload()
    expect(controller.store.getSnapshot()).toMatchObject({
      mode: 'api', listings: [], installedRecords: [record], error: null,
    })
    controller.dispose()
  })

  it('shows the failing step and never installs when a check fails', async () => {
    const listings = vi.fn().mockResolvedValue({ ok: true, value: catalog() })
    const installed = vi.fn().mockResolvedValue({ ok: true, value: { records: [] } })
    const preflight = vi.fn().mockResolvedValue({ ok: true, value: report() })
    const installListing = vi.fn()
    const controller = controllerWith({ listings, installed, installListing, preflight })
    await controller.reload()
    await controller.install('qianshou.article')
    expect(installListing).not.toHaveBeenCalled()
    const view = controller.store.getSnapshot()
    expect(view.error).toBe('preflightFailed')
    expect(view.busyId).toBeNull()
    expect(view.report?.failedStep).toBe('dependencies')
    expect(view.report?.steps.map(step => step.state)).toEqual(['passed', 'failed', 'not-checked', 'not-checked'])
    expect(view.report?.actions).toEqual(['fix', 'recheck', 'cancel', 'rollback'])
    expect(view.installedRecords).toEqual([])
    controller.dispose()
  })

  it('shows what the repair did and the checks it produced', async () => {
    const listings = vi.fn().mockResolvedValue({ ok: true, value: catalog() })
    const installed = vi.fn().mockResolvedValue({ ok: true, value: { records: [] } })
    const preflight = vi.fn().mockResolvedValue({ ok: true, value: report() })
    const repairListing = vi.fn().mockResolvedValue({
      ok: true, value: { listingId: 'qianshou.article', step: 'dependencies', outcome: 'repaired', detail: 'installed=qianshou-extra', report: passed() },
    })
    const controller = controllerWith({ listings, installed, preflight, repairListing })
    await controller.reload()
    await controller.install('qianshou.article')
    await controller.repair('qianshou.article')
    expect(repairListing).toHaveBeenCalledExactlyOnceWith({ id: 'qianshou.article' })
    const view = controller.store.getSnapshot()
    expect(view.notice).toBe('repairRepaired')
    expect(view.error).toBeNull()
    expect(view.report?.verdict).toBe('passed')
    expect(view.workingId).toBeNull()
    controller.dispose()
  })

  it('keeps the failure visible when the repair changed nothing', async () => {
    const listings = vi.fn().mockResolvedValue({ ok: true, value: catalog() })
    const installed = vi.fn().mockResolvedValue({ ok: true, value: { records: [] } })
    const repairListing = vi.fn().mockResolvedValue({
      ok: true, value: { listingId: 'qianshou.article', step: 'model', outcome: 'unavailable', detail: 'owner-model-route', report: report({ failedStep: 'model' }) },
    })
    const controller = controllerWith({ listings, installed, repairListing })
    await controller.reload()
    await controller.install('qianshou.article')
    await controller.repair('qianshou.article')
    expect(controller.store.getSnapshot()).toMatchObject({ notice: 'repairUnavailable', error: 'preflightFailed' })
    expect(controller.store.getSnapshot().report?.failedStep).toBe('model')
    controller.dispose()
  })

  it('checks again, clearing a failure once the checks pass', async () => {
    const listings = vi.fn().mockResolvedValue({ ok: true, value: catalog() })
    const installed = vi.fn().mockResolvedValue({ ok: true, value: { records: [] } })
    const preflight = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: report() })
      .mockResolvedValueOnce({ ok: true, value: passed() })
    const controller = controllerWith({ listings, installed, preflight })
    await controller.reload()
    await controller.install('qianshou.article')
    await controller.recheck('qianshou.article')
    expect(preflight).toHaveBeenCalledTimes(2)
    expect(controller.store.getSnapshot()).toMatchObject({ error: null, report: { verdict: 'passed' }, workingId: null })
    controller.dispose()
  })

  it('rolls back, then reads the market again and reports what the host restored', async () => {
    const listings = vi.fn().mockResolvedValue({ ok: true, value: catalog() })
    const installed = vi.fn().mockResolvedValue({ ok: true, value: { records: [] } })
    const rollbackListing = vi.fn().mockResolvedValue({
      ok: true, value: { listingId: 'qianshou.article', restored: true, reverted: [], detail: 'declaration-restored' },
    })
    const preflight = vi.fn().mockResolvedValue({ ok: true, value: report() })
    const controller = controllerWith({ listings, installed, preflight, rollbackListing })
    await controller.reload()
    await controller.install('qianshou.article')
    await controller.rollback('qianshou.article')
    expect(rollbackListing).toHaveBeenCalledExactlyOnceWith({ id: 'qianshou.article' })
    expect(listings).toHaveBeenCalledTimes(2)
    expect(controller.store.getSnapshot()).toMatchObject({ notice: 'rollbackRestored', report: null, error: null, loading: false })
    controller.dispose()
  })

  it('dismisses a failed check without calling the host again', async () => {
    const listings = vi.fn().mockResolvedValue({ ok: true, value: catalog() })
    const installed = vi.fn().mockResolvedValue({ ok: true, value: { records: [] } })
    const preflight = vi.fn().mockResolvedValue({ ok: true, value: report() })
    const controller = controllerWith({ listings, installed, preflight })
    await controller.reload()
    await controller.install('qianshou.article')
    controller.dismiss()
    expect(controller.store.getSnapshot()).toMatchObject({ error: null, report: null, notice: null, busyId: null })
    expect(controller.store.getSnapshot().listings).toHaveLength(1)
    expect(preflight).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('keeps a failed refresh distinct from an empty market and ignores a late install', async () => {
    const listings = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: catalog('api') })
      .mockResolvedValueOnce({ ok: false, error: { message: 'QIANSHOU_CATALOG_unavailable' } })
    const installed = vi.fn().mockResolvedValue({ ok: true, value: { records: [] } })
    const preflight = vi.fn()
    const installListing = vi.fn()
    const controller = controllerWith({ listings, installed, installListing, preflight })
    await controller.reload()
    await controller.reload()
    expect(controller.store.getSnapshot()).toMatchObject({ loading: false, error: 'unavailable', mode: 'api' })
    const late = Promise.withResolvers<{ ok: true, value: PreflightReportView }>()
    preflight.mockReturnValueOnce(late.promise)
    const pending = controller.install('qianshou.article')
    controller.dispose()
    const before = controller.store.getSnapshot()
    late.resolve({ ok: true, value: passed() })
    await pending
    expect(controller.store.getSnapshot()).toBe(before)
    expect(installListing).not.toHaveBeenCalled()
  })
})
