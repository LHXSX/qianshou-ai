/** Registry replacement reuses installation cancellation without changing enablement. */
import { describe, expect, it, vi } from 'vitest'
import type { BundleLoadCheck, ChangeResult, PluginUpdateInspection, PluginUpdateInspectionId } from '@deepseek-ai/dsh-plugin-manager/types'
import { PluginManagerController } from '../src/client/manager-store.ts'
import { LoadingCheckController } from '../src/client/loading-checks.ts'

const inspection: Extract<PluginUpdateInspection, { status: 'accepted' }> = {
  status: 'accepted', inspectionId: 'plan-1' as PluginUpdateInspectionId, expiresAt: Date.now() + 60_000,
  current: { name: '@test/bundle', version: '1.0.0', spec: '@test/bundle@1.0.0', enabled: false },
  target: { name: '@test/bundle', version: '2.0.0', spec: '@test/bundle@2.0.0' },
}
const completed: ChangeResult = { changed: true, application: 'restart-required', stage: 'enable', target: '@test/bundle', bundle: '@test/bundle' }
const ok = <T>(value: T) => ({ ok: true as const, value })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
function bench(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const remote = {
    listBundles: vi.fn(async () => ok([])), listPlugins: vi.fn(async () => ok([])),
    inspectUpdate: vi.fn(async () => ok(inspection)), updateBundle: vi.fn(async () => ok(completed)),
    installBundle: vi.fn(), setBundleEnabled: vi.fn(), cancelInstall: vi.fn(async () => ok({ status: 'cancelled' })),
    ...overrides,
  }
  const controller = new PluginManagerController({ remote: { pluginManager: remote,
    pluginInventory: { list: async () => ok({ entries: [], managementAvailable: true }) } } } as never)
  const face = controller.inject({ getSnapshot: () => ({ items: [], rows: new Set(), bundles: new Set() }), subscribe: () => () => {} })
  const state = () => controller.getSnapshot().install
  const review = async () => {
    face.openUpdate('@test/bundle'); face.editInstallSpec('@test/bundle@2.0.0'); face.runInstall()
    await vi.waitFor(() => { expect(state().phase).toBe('review') })
  }
  return { controller, face, remote, state, review }
}

describe('plugin version replacement', () => {
  it('waits for explicit confirmation and preserves selection after a replacement requiring restart', async () => {
    const b = bench()
    await b.review()
    expect(b.remote.updateBundle).not.toHaveBeenCalled()
    expect(b.state().update?.inspection?.current.enabled).toBe(false)
    b.face.runInstall()
    await vi.waitFor(() => { expect(b.state().phase).toBe('done') })
    expect(b.remote.updateBundle).toHaveBeenCalledTimes(1)
    expect(b.remote.updateBundle).toHaveBeenCalledWith('plan-1', expect.objectContaining({ requestId: b.state().requestId }))
    expect(b.remote.installBundle).not.toHaveBeenCalled()
    expect(b.state().restartRequired).toBe(true)
    b.face.enableInstalled()
    expect(b.remote.setBundleEnabled).not.toHaveBeenCalled()
    b.face.closeInstall()
    expect(b.state().open).toBe(false)
    b.controller.dispose()
  })

  it('returns a failed stale plan to inspection and confirmation rather than silently retrying replacement', async () => {
    const b = bench({ updateBundle: vi.fn(async () => ok({ ...completed, changed: false, application: 'failed', error: { code: 'stale-update' } })) })
    await b.review(); b.face.runInstall()
    await vi.waitFor(() => { expect(b.state().phase).toBe('failed') })
    expect(b.state().failure?.code).toBe('stale-update')
    b.face.runInstall()
    await vi.waitFor(() => { expect(b.state().phase).toBe('review') })
    expect(b.remote.inspectUpdate).toHaveBeenCalledTimes(2)
    expect(b.remote.updateBundle).toHaveBeenCalledTimes(1)
    b.controller.dispose()
  })

  it('keeps the update identity after a confirmed cancellation and ignores late update success', async () => {
    const run = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const b = bench({ updateBundle: vi.fn(() => run.promise) })
    await b.review(); b.face.runInstall()
    await vi.waitFor(() => { expect(b.state().phase).toBe('starting') })
    const id = b.state().requestId!
    b.controller.installProgress({ requestId: id, phase: 'installing' })
    b.face.cancelInstall()
    await vi.waitFor(() => { expect(b.state().phase).toBe('idle') })
    expect(b.state().update).toEqual({ name: '@test/bundle' })
    expect(b.controller.getSnapshot().notice).toMatchObject({ kind: 'cancelled', updating: true })
    run.resolve(ok(completed)); await run.promise
    expect(b.state().phase).toBe('idle')
    expect(b.remote.setBundleEnabled).not.toHaveBeenCalled()
    b.controller.dispose()
  })

  it('retries only the inspected replacement after explicit build-script approval', async () => {
    const update = vi.fn().mockResolvedValueOnce(ok({ ...completed, changed: false, application: 'failed',
      pendingBuilds: ['native-addon'], packageResult: { exitCode: 1, output: '', truncated: false, logPath: '', kind: 'build-blocked' } })).mockResolvedValueOnce(ok(completed))
    const b = bench({ updateBundle: update })
    await b.review(); b.face.runInstall()
    await vi.waitFor(() => { expect(b.state().phase).toBe('failed') })
    expect(update).toHaveBeenCalledTimes(1)
    b.face.approveBuildsAndRetry()
    await vi.waitFor(() => { expect(b.state().phase).toBe('done') })
    expect(update.mock.calls[1]?.[0]).toBe('plan-1')
    expect(update.mock.calls[1]?.[1]).toHaveProperty('approvedBuilds', ['native-addon'])
    expect(update.mock.calls[1]?.[1]).toHaveProperty('requestId')
    expect(b.remote.installBundle).not.toHaveBeenCalled()
    b.controller.dispose()
  })

  it('aborts and discards a late inspection after close or opening a new installation', async () => {
    const pending = deferred<ReturnType<typeof ok<PluginUpdateInspection>>>()
    const inspect = vi.fn((_name: string, _spec: string, _signal: AbortSignal) => pending.promise)
    const b = bench({ inspectUpdate: inspect })
    b.face.openUpdate('@test/bundle'); b.face.editInstallSpec('@test/bundle@2.0.0'); b.face.runInstall()
    expect(b.state().phase).toBe('checking')
    b.face.openInstall()
    expect(inspect.mock.calls[0]?.[2].aborted).toBe(true)
    pending.resolve(ok(inspection)); await pending.promise
    expect(b.state().phase).toBe('idle')
    expect(b.state().update).toBeUndefined()
    expect(b.remote.updateBundle).not.toHaveBeenCalled()
    b.controller.dispose()
  })

  it('shows an update refusal in the editable form without installing', async () => {
    const b = bench({ inspectUpdate: vi.fn(async () => ok({ status: 'refused', problem: 'update-unavailable', reason: 'local package' })) })
    b.face.openUpdate('@test/bundle'); b.face.editInstallSpec('@test/bundle@2.0.0'); b.face.runInstall()
    await vi.waitFor(() => { expect(b.state().inputError?.problem).toBe('update-unavailable') })
    expect(b.state().phase).toBe('idle')
    expect(b.remote.updateBundle).not.toHaveBeenCalled()
    b.controller.dispose()
  })
})

const check: BundleLoadCheck = { scope: 'host-loading', name: '@test/bundle', checkedAt: 1, selected: true, state: 'incomplete', rows: [{ rowId: 'wait', moduleName: '@test/wait', enabled: true, phase: 'pending' }], errors: [] }
describe('explicit Host loading checks', () => {
  it('coalesces a pending check and drops responses invalidated by a mutation or disposal', async () => {
    const pending = deferred<ReturnType<typeof ok<BundleLoadCheck>>>()
    const remote = vi.fn(() => pending.promise)
    const checks = new LoadingCheckController(remote)
    const first = checks.run(check.name)
    await checks.run(check.name)
    expect(remote).toHaveBeenCalledTimes(1)
    checks.invalidate(check.name)
    pending.resolve(ok(check)); await first
    expect(checks.store.getSnapshot()).toEqual({})
    const second = checks.run(check.name)
    checks.dispose(); await second
    expect(checks.store.getSnapshot()[check.name]?.status).toBe('checking')
  })

  it('retains the real Host state and reports transport failures without a successful check', async () => {
    const checks = new LoadingCheckController(vi.fn().mockResolvedValueOnce(ok(check)).mockRejectedValueOnce(new Error('disconnected')))
    await checks.run(check.name)
    expect(checks.store.getSnapshot()[check.name]).toEqual({ status: 'checked', result: check })
    await checks.run(check.name)
    expect(checks.store.getSnapshot()[check.name]).toEqual({ status: 'failed', reason: 'disconnected' })
    checks.invalidate()
    expect(checks.store.getSnapshot()).toEqual({})
    checks.dispose()
  })
})
