// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Context } from '@deepseek-ai/cordis'
import type { AvailabilityView, CatalogView, EstimateIntent, EstimateView } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyHost } from '../src/index.ts'
import { CapabilityController } from '../src/client/controller.ts'
import { CapabilityPanel, type CapabilityInjected, type CapabilityPanelProps } from '../src/client/CapabilityPanel.tsx'
import { en, zh } from '../src/client/locales.ts'
import { apply } from '../src/client/index.ts'

afterEach(cleanup)

const CHECKED = 1_700_000_000_000

const catalog: CatalogView = {
  state: 'catalog-only', source: 'https://qianshousuanli.com/api/v8/capabilities', registryVersion: 'v1', checkedAt: CHECKED,
  entries: [
    { id: 'video.transcode', title: '视频转码', taskType: 'video_transcode' },
    { id: 'accelerator.gpu', title: 'GPU 加速器', taskType: null },
  ],
}

const availability: AvailabilityView = {
  state: 'catalog-only', capabilityId: 'video.transcode', source: 'https://qianshousuanli.com/api/v8/capabilities/video.transcode/workers',
  registryVersion: 'v1', checkedAt: CHECKED,
  declared: { count: 4, byImpl: { ffmpeg: 4 } },
  availableNow: { count: 0, byImpl: {}, onlineTtlSeconds: 90 },
}

const estimate: EstimateView = {
  state: 'estimate-only', capabilityId: 'video.transcode', taskType: 'video_transcode',
  source: 'https://qianshousuanli.com/api/v8/economy/estimate', currency: 'CNY',
  estimatedTotal: '1.20', recommendedBudget: '1.50', balanceEnough: true, billingMode: 'prepaid',
  fields: { estimatedTotal: 'estimated_total', recommendedBudget: 'recommended_budget' },
  intent: { goal: '转码一段素材', budget: null }, checkedAt: CHECKED,
}

/** Interpolate exactly like the runtime translator so a missing placeholder shows up as a test failure. */
function translate(key: keyof typeof zh, params?: Record<string, string>): string {
  return Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, value), zh[key])
}

/** Name which catalog generation the store holds, so a dropped answer is visible as a version. */
function registryVersionOf(view: CatalogView | null): string | null {
  return view?.state === 'catalog-only' ? view.registryVersion : null
}

/** What a generated Remote method resolves to; the failure branch carries no detail this card reads. */
type Read<View> = { ok: true; value: View } | { ok: false; error: RemoteError }

/** The carrier answered, and the answer is a refusal — distinct from the call itself failing. */
function refused<View>(): Read<View> {
  return { ok: false, error: new RemoteError('gateway/internal', 'remote refused', {}) }
}

function fixture(views: { catalog?: CatalogView; availability?: AvailabilityView; estimate?: EstimateView } = {}) {
  const remote = {
    catalog: vi.fn(async (): Promise<Read<CatalogView>> => ({ ok: true, value: views.catalog ?? catalog })),
    availability: vi.fn(async (_capabilityId: string): Promise<Read<AvailabilityView>> =>
      ({ ok: true, value: views.availability ?? availability })),
    estimate: vi.fn(async (_capabilityId: string, _intent: EstimateIntent): Promise<Read<EstimateView>> =>
      ({ ok: true, value: views.estimate ?? estimate })),
  }
  const controller = new CapabilityController({ remote: { qianshouCapability: remote } } as unknown as Context)
  const props = { controller, useCapability: bindSnapshotSelector(controller.store), t: translate } as CapabilityPanelProps
  return { controller, remote, props }
}

describe('capability section registration', () => {
  it.each([undefined, 'default', 'official'])('registers nothing outside Qianshou builds: %s', (profile) => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', profile)
    const effect = vi.fn()
    const register = vi.fn()
    const inject = vi.fn()
    try {
      apply({ effect, locale: { register }, slots: { inject } } as unknown as Context)
      expect(effect).not.toHaveBeenCalled()
      expect(register).not.toHaveBeenCalled()
      expect(inject).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('needs no Host context, because the Host half installs nothing', () => {
    expect(applyHost).toHaveLength(0)
    expect(applyHost).not.toThrow()
  })

  it('registers copy, one settings section and a reconnect reload in a Qianshou build', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
    vi.resetModules()
    try {
      const plugin = await import('../src/client/index.ts')
      expect(plugin.inject).toContain('remote.qianshouCapability')
      const remote = { catalog: vi.fn(async () => ({ ok: true as const, value: catalog })) }
      const sections: Array<{ spec: Record<string, unknown>; component: unknown }> = []
      const listeners = new Map<string, () => void>()
      const namespaces = new Map<string, unknown>()
      plugin.apply({
        effect: (install: () => unknown) => install(),
        locale: {
          register: (namespace: string, dictionaries: unknown) => { namespaces.set(namespace, dictionaries) },
          bind: () => (key: keyof typeof zh) => zh[key],
        },
        slots: {
          inject: (_name: string, install: () => unknown) => install(),
          register: (spec: Record<string, unknown>, component: unknown) => { sections.push({ spec, component }) },
        },
        on: (event: string, listener: () => void) => { listeners.set(event, listener) },
        remote: { qianshouCapability: remote },
      } as unknown as Context)

      expect(namespaces.get('qianshou.capability')).toEqual({ zh, en })
      expect(sections).toHaveLength(1)
      const [section] = sections
      expect(section?.spec).toMatchObject({ name: 'settings.section', id: 'qianshou-capability', locale: 'qianshou.capability' })
      expect((section?.spec.label as () => string)()).toBe(zh.title)
      expect((section?.spec.inject as () => CapabilityInjected)().hooks.capability.getSnapshot().catalog).toBeNull()
      expect(remote.catalog).not.toHaveBeenCalled()
      listeners.get('connection/reset')?.()
      await vi.waitFor(() => { expect(remote.catalog).toHaveBeenCalledTimes(1) })
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})

describe('the three layers stay separate on screen', () => {
  it('lists the catalog and says listed is not runnable, without reading any worker count', async () => {
    const { props, remote } = fixture()
    render(<CapabilityPanel {...props} />)
    await waitFor(() => { expect(screen.getByText('视频转码')).toBeTruthy() })
    expect(screen.getByText(zh.catalogOnly, { exact: false })).toBeTruthy()
    expect(remote.availability).not.toHaveBeenCalled()
    expect(remote.estimate).not.toHaveBeenCalled()
  })

  it('reports four declared and none online as zero online, not as absent', async () => {
    const { props, remote } = fixture()
    render(<CapabilityPanel {...props} />)
    await waitFor(() => { expect(screen.getByText('视频转码')).toBeTruthy() })
    fireEvent.click(screen.getByText('视频转码'))
    await waitFor(() => { expect(screen.getByText(translate('availableNow', { count: '0' }))).toBeTruthy() })
    expect(screen.getByText(translate('declared', { count: '4' }))).toBeTruthy()
    expect(screen.getByText(translate('onlineTtl', { seconds: '90' }))).toBeTruthy()
    expect(remote.availability).toHaveBeenCalledWith('video.transcode')
  })

  it('shows an estimate as an estimate and cites the server field behind each number', async () => {
    const { controller, props } = fixture()
    render(<CapabilityPanel {...props} />)
    await controller.select('video.transcode')
    await controller.runEstimate({ goal: '转码一段素材', budget: null })
    await waitFor(() => { expect(screen.getByText(zh.notAQuote)).toBeTruthy() })
    expect(screen.getByText('1.20 CNY')).toBeTruthy()
    expect(screen.getByText('estimatedTotal · estimated_total')).toBeTruthy()
  })

  it('posts the goal and the local budget cap the user typed', async () => {
    const { props, remote } = fixture()
    render(<CapabilityPanel {...props} />)
    await waitFor(() => { expect(screen.getByText('视频转码')).toBeTruthy() })
    fireEvent.click(screen.getByText('视频转码'))
    await waitFor(() => { expect(screen.getByLabelText(zh.goal)).toBeTruthy() })
    fireEvent.change(screen.getByLabelText(zh.goal), { target: { value: '转码一段素材' } })
    fireEvent.change(screen.getByLabelText(zh.budget), { target: { value: '500' } })
    fireEvent.click(screen.getByText(zh.estimate))
    await waitFor(() => {
      expect(remote.estimate).toHaveBeenCalledWith('video.transcode', { goal: '转码一段素材', budget: { amount_minor: 500, currency: 'CNY' } })
    })
  })

  it('splits the online count per implementation once any worker answers', async () => {
    const { props } = fixture({
      availability: { ...availability, availableNow: { count: 3, byImpl: { ffmpeg: 2, 'ffmpeg-nvenc': 1 }, onlineTtlSeconds: 90 } },
    })
    render(<CapabilityPanel {...props} />)
    await waitFor(() => { expect(screen.getByText('视频转码')).toBeTruthy() })
    fireEvent.click(screen.getByText('视频转码'))
    await waitFor(() => { expect(screen.getByText(zh.byImpl)).toBeTruthy() })
    expect(screen.getByText('ffmpeg 2')).toBeTruthy()
    expect(screen.getByText('ffmpeg-nvenc 1')).toBeTruthy()
  })

  it('falls back to the id when the registry copy carries no title, and says so when no version was given', async () => {
    const { props } = fixture({
      catalog: { ...catalog, registryVersion: null, entries: [{ id: 'video.transcode', title: null, taskType: 'video_transcode' }] },
    })
    render(<CapabilityPanel {...props} />)
    await waitFor(() => { expect(screen.getAllByText('video.transcode')).toHaveLength(1) })
    expect(screen.getByText(zh.noRegistry, { exact: false })).toBeTruthy()
  })

  it('re-reads the catalog when the user asks for a refresh', async () => {
    const { props, remote } = fixture()
    render(<CapabilityPanel {...props} />)
    await waitFor(() => { expect(remote.catalog).toHaveBeenCalledTimes(1) })
    fireEvent.click(screen.getByText(zh.refresh))
    await waitFor(() => { expect(remote.catalog).toHaveBeenCalledTimes(2) })
  })

  it('reads the goal with no budget when the user leaves the cap empty, and the currency the user typed', async () => {
    const { props, remote } = fixture()
    render(<CapabilityPanel {...props} />)
    await waitFor(() => { expect(screen.getByText('视频转码')).toBeTruthy() })
    fireEvent.click(screen.getByText('视频转码'))
    await waitFor(() => { expect(screen.getByLabelText(zh.goal)).toBeTruthy() })
    fireEvent.change(screen.getByLabelText(zh.goal), { target: { value: '转码一段素材' } })
    fireEvent.click(screen.getByText(zh.estimate))
    await waitFor(() => {
      expect(remote.estimate).toHaveBeenCalledWith('video.transcode', { goal: '转码一段素材', budget: null })
    })

    fireEvent.change(screen.getByLabelText(zh.budget), { target: { value: '300' } })
    fireEvent.change(screen.getByLabelText(zh.currency), { target: { value: 'USD' } })
    fireEvent.click(screen.getByText(zh.estimate))
    await waitFor(() => {
      expect(remote.estimate).toHaveBeenLastCalledWith('video.transcode', {
        goal: '转码一段素材', budget: { amount_minor: 300, currency: 'USD' },
      })
    })
  })

  it('says the balance falls short without changing any amount it was given', async () => {
    const { controller, props } = fixture({ estimate: { ...estimate, balanceEnough: false } })
    render(<CapabilityPanel {...props} />)
    await controller.select('video.transcode')
    await controller.runEstimate({ goal: '转码一段素材', budget: null })
    await waitFor(() => { expect(screen.getByText(zh.balanceShort)).toBeTruthy() })
    expect(screen.getByText('1.50 CNY')).toBeTruthy()
  })

  it('refuses to offer an estimate for a capability the local registry has no landing for', async () => {
    const { props, remote } = fixture()
    render(<CapabilityPanel {...props} />)
    await waitFor(() => { expect(screen.getByText('GPU 加速器')).toBeTruthy() })
    fireEvent.click(screen.getByText('GPU 加速器'))
    await waitFor(() => { expect(screen.getByText(zh.estimate)).toHaveProperty('disabled', true) })
    expect(remote.estimate).not.toHaveBeenCalled()
  })
})

describe('named failures reach the user', () => {
  it('distinguishes signed-out from an empty catalog', async () => {
    const { props: out } = fixture({ catalog: { state: 'signed-out', source: 'https://qianshousuanli.com/api/v8/capabilities' } })
    const { unmount } = render(<CapabilityPanel {...out} />)
    await waitFor(() => { expect(screen.getByText(zh.signedOut)).toBeTruthy() })
    unmount()
    const { props: empty } = fixture({ catalog: { ...catalog, entries: [] } })
    render(<CapabilityPanel {...empty} />)
    await waitFor(() => { expect(screen.getByText(zh.empty)).toBeTruthy() })
  })

  it('names the failure and its HTTP status instead of an empty list', async () => {
    const { props } = fixture({ catalog: { state: 'unavailable', source: 'https://qianshousuanli.com/api/v8/capabilities', failure: 'rate-limited', httpStatus: 429 } })
    render(<CapabilityPanel {...props} />)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(zh['rate-limited']) })
    expect(screen.getByRole('alert').textContent).toContain('HTTP 429')
  })

  it('names a failing scheduler read and a missing session under the selected capability', async () => {
    const source = 'https://qianshousuanli.com/api/v8/capabilities/video.transcode/workers'
    const { props: down } = fixture({
      availability: { state: 'unavailable', capabilityId: 'video.transcode', source, failure: 'not-in-catalog', httpStatus: 404 },
    })
    const { unmount } = render(<CapabilityPanel {...down} />)
    await waitFor(() => { expect(screen.getByText('视频转码')).toBeTruthy() })
    fireEvent.click(screen.getByText('视频转码'))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(zh['not-in-catalog']) })
    unmount()

    const { props: out } = fixture({ availability: { state: 'signed-out', capabilityId: 'video.transcode', source } })
    render(<CapabilityPanel {...out} />)
    await waitFor(() => { expect(screen.getByText('视频转码')).toBeTruthy() })
    fireEvent.click(screen.getByText('视频转码'))
    await waitFor(() => { expect(screen.getByText(zh.signedOut)).toBeTruthy() })
  })

  it('names a failing estimate read instead of showing no amounts', async () => {
    const { controller, props } = fixture({
      estimate: {
        state: 'unavailable', capabilityId: 'video.transcode',
        source: 'https://qianshousuanli.com/api/v8/economy/estimate', failure: 'invalid-input', httpStatus: 400,
      },
    })
    render(<CapabilityPanel {...props} />)
    await controller.select('video.transcode')
    await controller.runEstimate({ goal: '', budget: null })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(zh['invalid-input']) })
  })

  it('tells the user the window lost the Host, which is not an empty catalog', async () => {
    const { props, remote } = fixture()
    remote.catalog.mockRejectedValueOnce(new Error('connection lost'))
    render(<CapabilityPanel {...props} />)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(zh.network) })
    expect(screen.queryByText(zh.empty)).toBeNull()
    expect(screen.queryByText(zh.loading)).toBeNull()
  })

  it('renders the read-limit failure with its own copy, not the reading indicator', async () => {
    const { props } = fixture({ catalog: { state: 'unavailable', source: 'https://qianshousuanli.com/api/v8/capabilities', failure: 'busy', httpStatus: null } })
    render(<CapabilityPanel {...props} />)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(zh.busyFailure) })
  })
})

describe('stale answers never land on another capability', () => {
  it('drops an availability answer that a newer selection superseded', async () => {
    const first: AvailabilityView = { ...availability, declared: { count: 4, byImpl: {} } }
    const second: AvailabilityView = { ...availability, capabilityId: 'accelerator.gpu', declared: { count: 9, byImpl: {} } }
    let release = (): void => {}
    const remote = {
      catalog: vi.fn(async () => ({ ok: true as const, value: catalog })),
      availability: vi.fn(async (id: string) => {
        if (id === 'video.transcode') await new Promise<void>((resolve) => { release = resolve })
        return { ok: true as const, value: id === 'video.transcode' ? first : second }
      }),
      estimate: vi.fn(async () => ({ ok: true as const, value: estimate })),
    }
    const controller = new CapabilityController({ remote: { qianshouCapability: remote } } as unknown as Context)
    const slow = controller.select('video.transcode')
    await controller.select('accelerator.gpu')
    release()
    await slow
    expect(controller.store.getSnapshot().availability?.capabilityId).toBe('accelerator.gpu')
  })

  it('clears the previous estimate when the selection changes', async () => {
    const { controller } = fixture()
    await controller.select('video.transcode')
    await controller.runEstimate({ goal: '转码一段素材', budget: null })
    expect(controller.store.getSnapshot().estimate?.state).toBe('estimate-only')
    await controller.select('accelerator.gpu')
    expect(controller.store.getSnapshot().estimate).toBeNull()
  })

  it('drops a catalog answer a newer refresh superseded, and the failure of a superseded one', async () => {
    const newer: CatalogView = { ...catalog, registryVersion: 'v2' }
    const { controller, remote } = fixture()
    let release = (): void => {}
    remote.catalog.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { ok: true, value: catalog }
    })
    remote.catalog.mockImplementationOnce(async () => ({ ok: true, value: newer }))
    const superseded = controller.loadCatalog()
    await controller.loadCatalog()
    release()
    await superseded
    expect(registryVersionOf(controller.store.getSnapshot().catalog)).toBe('v2')

    remote.catalog.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      throw new Error('connection lost')
    })
    remote.catalog.mockImplementationOnce(async () => ({ ok: true, value: catalog }))
    const lost = controller.loadCatalog()
    await controller.loadCatalog()
    release()
    await lost
    const state = controller.store.getSnapshot()
    expect(state.failed).toBe(false)
    expect(state.busy).toBe(false)
    expect(registryVersionOf(state.catalog)).toBe('v1')
  })

  it('keeps the last good catalog when the carrier answers with a refusal', async () => {
    const { controller, remote } = fixture()
    await controller.loadCatalog()
    remote.catalog.mockResolvedValueOnce(refused())
    await controller.loadCatalog()
    const state = controller.store.getSnapshot()
    expect(state.failed).toBe(true)
    expect(registryVersionOf(state.catalog)).toBe('v1')
  })

  it('clears availability when the carrier refuses it, and reports the RPC failing on its own', async () => {
    const { controller, remote } = fixture()
    remote.availability.mockResolvedValueOnce(refused())
    await controller.select('video.transcode')
    expect(controller.store.getSnapshot()).toMatchObject({ availability: null, failed: true })

    remote.availability.mockRejectedValueOnce(new Error('connection lost'))
    await controller.select('video.transcode')
    expect(controller.store.getSnapshot()).toMatchObject({ busy: false, failed: true })
  })

  it('leaves no failure behind when a superseded selection fails', async () => {
    const { controller, remote } = fixture()
    let release = (): void => {}
    remote.availability.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      throw new Error('connection lost')
    })
    const superseded = controller.select('video.transcode')
    await controller.select('accelerator.gpu')
    release()
    await superseded
    expect(controller.store.getSnapshot()).toMatchObject({ selected: 'accelerator.gpu', busy: false, failed: false })
  })

  it('reads no estimate while nothing is selected', async () => {
    const { controller, remote } = fixture()
    await controller.runEstimate({ goal: '转码一段素材', budget: null })
    expect(remote.estimate).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().estimate).toBeNull()
  })

  it('clears the estimate when the carrier refuses it, and reports the RPC failing on its own', async () => {
    const { controller, remote } = fixture()
    await controller.select('video.transcode')
    remote.estimate.mockResolvedValueOnce(refused())
    await controller.runEstimate({ goal: '转码一段素材', budget: null })
    expect(controller.store.getSnapshot()).toMatchObject({ estimate: null, failed: true })

    remote.estimate.mockRejectedValueOnce(new Error('connection lost'))
    await controller.runEstimate({ goal: '转码一段素材', budget: null })
    expect(controller.store.getSnapshot()).toMatchObject({ busy: false, failed: true })
  })

  it('drops an estimate the user superseded by selecting another capability', async () => {
    const { controller, remote } = fixture()
    await controller.select('video.transcode')
    let release = (): void => {}
    remote.estimate.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { ok: true, value: estimate }
    })
    const superseded = controller.runEstimate({ goal: '转码一段素材', budget: null })
    await controller.select('accelerator.gpu')
    release()
    await superseded
    expect(controller.store.getSnapshot().estimate).toBeNull()
  })

  it('leaves no failure behind when a superseded estimate fails', async () => {
    const { controller, remote } = fixture()
    await controller.select('video.transcode')
    let release = (): void => {}
    remote.estimate.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      throw new Error('connection lost')
    })
    const superseded = controller.runEstimate({ goal: '转码一段素材', budget: null })
    await controller.select('accelerator.gpu')
    release()
    await superseded
    expect(controller.store.getSnapshot()).toMatchObject({ busy: false, failed: false })
  })

  it('keeps the last good catalog when a refresh fails at the RPC itself', async () => {
    const { controller, remote } = fixture()
    await controller.loadCatalog()
    remote.catalog.mockRejectedValueOnce(new Error('connection lost'))
    await controller.loadCatalog()
    const state = controller.store.getSnapshot()
    expect(state.failed).toBe(true)
    expect(state.catalog?.state).toBe('catalog-only')
  })
})
