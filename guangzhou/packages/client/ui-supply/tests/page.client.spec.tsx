// @vitest-environment jsdom
/**
 * Page coverage for the facts the owner must be able to trust: every blocking
 * reason is readable, every unreported fact stays "unknown", and no amount is
 * ever invented for a payment flow that has no data source.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { SupplyPage, SupplyIcon, type SupplyPageProps } from '../src/client/SupplyPage.tsx'
import type { SupplyState } from '../src/client/controller.ts'
import type { SupplyPolicy } from '@deepseek-ai/dsh-compute-core/supply'
import { zh, type SupplyKey } from '../src/client/locales.ts'
import { blockedJson, emptyJson, readyJson, snapshot } from './fixtures.client.ts'

afterEach(cleanup)

function bench(change: Partial<SupplyState> = {}) {
  const store = createSnapshotStore<SupplyState>({
    snapshot: snapshot(), stale: false, loading: false, saving: false, error: null, ...change,
  })
  const actions = { refresh: vi.fn(async () => {}), savePolicy: vi.fn(async (_policy: SupplyPolicy) => true) }
  const t = (key: SupplyKey, values?: Record<string, unknown>): string => Object.entries(values ?? {})
    .reduce<string>((text, [name, value]) => text.replace(`{${name}}`, String(value)), zh[key])
  render(<SupplyPage {...{ ...actions, t, useSupply: bindSnapshotSelector(store) } as unknown as SupplyPageProps} />)
  return { store, actions }
}

const factText = (fact: string): string => document.querySelector(`[data-fact="${fact}"] dd`)?.textContent ?? ''
const reasonCodes = (): string[] => [...document.querySelectorAll('[data-reason]')].map(node => node.getAttribute('data-reason') ?? '')
const emptyInventory = { ...emptyJson, ownerPolicy: { ...emptyJson.ownerPolicy, mode: 'off' }, eligibility: { state: 'disabled', reasons: ['OWNER_DISABLED'] } }
const toolRow = (): HTMLElement => document.querySelector('[data-service="tool-ffmpeg"]') as HTMLElement
const modelRow = (): HTMLElement => document.querySelector('[data-service="ollama:abc"]') as HTMLElement

describe('supply workspace facts', () => {
  it('renders every blocking reason of this observation, one by one, with its code', () => {
    bench()
    expect(reasonCodes()).toEqual(['HOST_ACTIVITY_UNKNOWN', 'FOREGROUND_PRIORITY', 'USER_ACTIVE'])
    expect(screen.getByText(zh.reasonActivityUnknown)).toBeTruthy()
    expect(screen.getByText(zh.reasonForegroundPriority)).toBeTruthy()
    expect(screen.getByText(zh.reasonUserActive)).toBeTruthy()
    expect(screen.getByText(zh.stateBlocked)).toBeTruthy()
    expect(screen.getByText(zh.hintBlocked)).toBeTruthy()
  })

  it('shows an undocumented reason code verbatim instead of hiding the block', () => {
    bench({ snapshot: snapshot({ ...blockedJson, eligibility: { state: 'blocked', reasons: ['SOME_NEW_HOST_REASON'] } }) })
    expect(screen.getByText(zh.reasonUnknownCode)).toBeTruthy()
    expect(screen.getByText('SOME_NEW_HOST_REASON')).toBeTruthy()
  })

  it('says so when an observation reported no blocking reason', () => {
    bench({ snapshot: snapshot(readyJson) })
    expect(screen.getByText(zh.noReasons)).toBeTruthy()
    expect(reasonCodes()).toEqual([])
    expect(screen.getByText(zh.stateReady)).toBeTruthy()
    expect(screen.getByText(zh.hintReady)).toBeTruthy()
  })

  it('renders an unreported activity fact as unknown, never as 0, false or idle', () => {
    bench()
    expect(factText('idle')).toBe('12 秒')
    expect(factText('foregroundTask')).toBe(zh.yes)
    expect(factText('voice')).toBe(zh.unknown)
    expect(factText('voice')).not.toBe(zh.no)
    expect(screen.getByText(zh.factsHint)).toBeTruthy()
  })

  it('renders a fully unobserved activity block as unknown', () => {
    bench({ snapshot: snapshot({ ...blockedJson, activity: { idleSeconds: null, foregroundTaskActive: null, voiceActive: null } }) })
    expect([factText('idle'), factText('foregroundTask'), factText('voice')]).toEqual([zh.unknown, zh.unknown, zh.unknown])
    expect(factText('idle')).not.toBe('0 秒')
  })

  it('buckets an idle duration above a minute', () => {
    bench({ snapshot: snapshot({ ...blockedJson, activity: { ...blockedJson.activity, idleSeconds: 3600 } }) })
    expect(factText('idle')).toBe('1 小时')
  })

  it('shows hardware facts with their exact byte counts and never invents a GPU', () => {
    bench({
      snapshot: snapshot({
        ...blockedJson,
        hardware: { ...blockedJson.hardware, gpus: [], probeErrors: ['GPU_PROBE_UNAVAILABLE', 'UNRECORDED_PROBE'] },
      }),
    })
    expect(factText('logicalCores')).toBe('12 核')
    expect(factText('totalMemory')).toBe('36GB（38654705664 B）')
    expect(screen.getByText(zh.gpuNone)).toBeTruthy()
    expect(screen.getByText(zh.probeErrorGpu)).toBeTruthy()
    expect(document.querySelector('[data-probe-error="UNRECORDED_PROBE"]')?.textContent)
      .toBe(`${zh.unknownCode}UNRECORDED_PROBE`)
  })

  it('renders a GPU without a reported memory size as unknown VRAM', () => {
    bench({ snapshot: snapshot({ ...blockedJson, hardware: { ...blockedJson.hardware, probeErrors: [] } }) })
    expect(screen.getByText('Apple M3 Pro · Apple · 显存未知')).toBeTruthy()
  })

  it('renders a GPU with a vendor and a memory size without adding any', () => {
    bench({
      snapshot: snapshot({
        ...blockedJson,
        hardware: {
          ...blockedJson.hardware, probeErrors: [],
          gpus: [{ name: 'RTX 4090', vendor: 'NVIDIA', memoryBytes: 25769803776 }, { name: 'Unknown adapter', vendor: null, memoryBytes: null }],
        },
      }),
    })
    expect(screen.getByText('RTX 4090 · NVIDIA · 24GB')).toBeTruthy()
    expect(screen.getByText('Unknown adapter · 显存未知')).toBeTruthy()
  })

  it('shows an undocumented probe reason code verbatim', () => {
    bench({
      snapshot: snapshot({
        ...blockedJson,
        localServices: [
          ...blockedJson.localServices,
          { id: 'tool-odd', kind: 'tool', name: 'odd-tool', version: null, verification: 'unavailable', reason: 'SOME_NEW_SERVICE_REASON' },
        ],
      }),
    })
    expect(document.querySelector('[data-service-reason="SOME_NEW_SERVICE_REASON"]')?.textContent)
      .toBe(`${zh.unknownCode}SOME_NEW_SERVICE_REASON`)
  })

  it('shows the observation time and marks a stale snapshot as the previous success', () => {
    const { store } = bench({ stale: true })
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(blockedJson.observedAt)
    expect(screen.getByText(zh.staleObservation)).toBeTruthy()
    act(() => { store.update((state) => { state.stale = false }) })
    expect(screen.queryByText(zh.staleObservation)).toBeNull()
  })
})

describe('supply workspace boundaries', () => {
  it('shows an unobserved machine as unknown with the failure, and no editable policy', () => {
    bench({ snapshot: null, stale: true, loading: false, error: { code: 'AUTH_REQUIRED', message: '请重新验证连接' } })
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain(zh.errorAuthRequired)
    expect(screen.getByText(zh.stateUnknown)).toBeTruthy()
    expect(screen.getByText(zh.observedAtUnknown)).toBeTruthy()
    expect(screen.getByText(zh.noObservation)).toBeTruthy()
    expect([factText('idle'), factText('foregroundTask'), factText('voice'), factText('platform')])
      .toEqual([zh.unknown, zh.unknown, zh.unknown, zh.unknown])
    expect(screen.queryByRole('button', { name: zh.save })).toBeNull()
    expect(screen.queryByLabelText(zh.maxConcurrency)).toBeNull()
  })

  it('names a rejected policy and a missing storage explicitly', () => {
    const { store } = bench({ error: { code: 'SUPPLY_POLICY_INVALID', message: 'SUPPLY_POLICY_INVALID' } })
    expect(screen.getByText(zh.errorPolicyInvalid)).toBeTruthy()
    expect(screen.getByText('SUPPLY_POLICY_INVALID')).toBeTruthy()
    act(() => { store.update((state) => { state.error = { code: 'SUPPLY_STORAGE_UNAVAILABLE', message: 'SUPPLY_STORAGE_UNAVAILABLE' } }) })
    expect(screen.getByText(zh.errorStorageUnavailable)).toBeTruthy()
  })

  it('reports an incomplete response instead of showing partial facts', () => {
    bench({ snapshot: null, error: { code: 'INVALID_SUPPLY_RESPONSE', message: 'INVALID_SUPPLY_RESPONSE' } })
    expect(screen.getByText(zh.errorInvalidResponse)).toBeTruthy()
  })

  it('shows an empty capability inventory as an empty state that still saves a policy', async () => {
    const { actions } = bench({ snapshot: snapshot(emptyInventory) })
    expect(screen.getByText(zh.noServices)).toBeTruthy()
    expect(screen.getByText(zh.noServicesHint)).toBeTruthy()
    expect(screen.getByText(zh.ratesNone)).toBeTruthy()
    expect(screen.getByText(zh.stateDisabled)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.save })) })
    expect(actions.savePolicy).toHaveBeenCalledWith({
      mode: 'off', maxConcurrency: 2, minFreeMemoryBytes: 4294967296, minIdleSeconds: 300, enabledServiceIds: [], nodeRates: [],
    })
  })

  it('shows advertisement state and only the capabilities the host acknowledged', () => {
    bench({ snapshot: snapshot(readyJson) })
    expect(screen.getByText(zh.advertisingAdvertising)).toBeTruthy()
    expect(screen.getByText('tool-ffmpeg')).toBeTruthy()
    expect(screen.getByText(zh.dispatchBoundary)).toBeTruthy()
  })

  it('contradicts nothing when advertising is reported with no acknowledged capability', () => {
    bench({ snapshot: snapshot({ ...readyJson, advertisedCapabilityIds: [] }) })
    expect(screen.getByText(zh.advertisedEmpty)).toBeTruthy()
    expect(screen.queryByText(zh.noAdvertisedCapabilities)).toBeNull()
  })

  it('states that settlement is not connected and fabricates no amount or earnings action', () => {
    bench({ snapshot: snapshot(readyJson) })
    expect(screen.getByText(zh.earningsNotConnected)).toBeTruthy()
    expect(screen.getByText(zh.earningsHint)).toBeTruthy()
    expect(screen.getByText(zh.boundary)).toBeTruthy()
    for (const banned of [/￥\s*\d/u, /\d+(?:\.\d+)?\s*元/u, /CNY\s*\d/u, /预计收益[:：]\s*\d/u]) {
      expect(screen.queryByText(banned)).toBeNull()
    }
    expect(screen.queryByRole('button', { name: /立即接单|开始赚钱|提现/u })).toBeNull()
  })
})

describe('supply policy editor', () => {
  it('saves the complete policy, including the rate settings it does not edit', async () => {
    const { actions } = bench()
    fireEvent.change(screen.getByLabelText(zh.mode), { target: { value: 'allowed' } })
    fireEvent.change(screen.getByLabelText(zh.maxConcurrency), { target: { value: '6' } })
    fireEvent.change(screen.getByLabelText(zh.minFreeMemoryMiB), { target: { value: '2048' } })
    fireEvent.change(screen.getByLabelText(zh.minIdleSeconds), { target: { value: '60' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.save })) })
    expect(actions.savePolicy).toHaveBeenCalledWith({
      mode: 'allowed', maxConcurrency: 6, minFreeMemoryBytes: 2048 * 1048576, minIdleSeconds: 60,
      enabledServiceIds: ['tool-ffmpeg'],
      nodeRates: [{ localServiceId: 'tool-ffmpeg', amountMinor: 250, unit: 'per-image', currency: 'CNY' }],
    })
    expect(screen.getByRole('status').textContent).toBe(zh.saved)
  })

  it('keeps the saved byte count when the memory field is left blank', async () => {
    const { actions } = bench()
    expect(screen.getByLabelText(zh.minFreeMemoryMiB)).toHaveProperty('value', '')
    expect(document.querySelector('[data-fact="memoryCurrent"]')?.textContent).toContain('4.0GB')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.save })) })
    expect(actions.savePolicy.mock.calls[0]![0].minFreeMemoryBytes).toBe(4294967296)
  })

  it('refuses an invalid entry locally and never calls the host', async () => {
    const { actions } = bench()
    fireEvent.change(screen.getByLabelText(zh.maxConcurrency), { target: { value: '0' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.save })) })
    expect(actions.savePolicy).not.toHaveBeenCalled()
    expect(document.querySelector('[data-problem="maxConcurrency"]')?.textContent).toBe(zh.invalidMaxConcurrency)
    fireEvent.change(screen.getByLabelText(zh.maxConcurrency), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText(zh.minFreeMemoryMiB), { target: { value: '1.5' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.save })) })
    expect(document.querySelector('[data-problem="minFreeMemory"]')?.textContent).toBe(zh.invalidMinFreeMemory)
    expect(document.querySelector('[data-fact="memoryEffective"]')).toBeNull()
    expect(actions.savePolicy).not.toHaveBeenCalled()
  })

  it('shows the effective memory floor for a valid override', () => {
    bench()
    fireEvent.change(screen.getByLabelText(zh.minFreeMemoryMiB), { target: { value: '2048' } })
    expect(document.querySelector('[data-fact="memoryEffective"]')?.textContent)
      .toBe(zh.minFreeMemoryEffective.replace('{size}', '2.0GB').replace('{bytes}', '2147483648'))
  })

  it('reports a host rejection and keeps the unsaved edit retryable', async () => {
    const { store, actions } = bench()
    actions.savePolicy.mockResolvedValue(false)
    fireEvent.change(screen.getByLabelText(zh.maxConcurrency), { target: { value: '3' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.save })) })
    act(() => { store.update((state) => { state.error = { code: 'SUPPLY_POLICY_INVALID', message: 'SUPPLY_POLICY_INVALID' } }) })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText(zh.errorPolicyInvalid)).toBeTruthy()
    expect(screen.getByText(zh.unsaved)).toBeTruthy()
    expect(screen.getByLabelText(zh.maxConcurrency)).toHaveProperty('value', '3')
  })

  it('never lets a background observation overwrite an unsaved edit', () => {
    const { store } = bench()
    fireEvent.change(screen.getByLabelText(zh.minIdleSeconds), { target: { value: '5' } })
    expect(screen.getByText(zh.unsaved)).toBeTruthy()
    act(() => { store.update((state) => { state.snapshot = snapshot(readyJson) }) })
    expect(screen.getByLabelText(zh.minIdleSeconds)).toHaveProperty('value', '5')
    expect(screen.getByText(zh.unsaved)).toBeTruthy()
  })

  it('keeps an enabled capability removable and shows its self-check reason', () => {
    bench({
      snapshot: snapshot({
        ...blockedJson,
        ownerPolicy: { ...blockedJson.ownerPolicy, enabledServiceIds: ['tool-ffmpeg', 'ollama:abc'] },
      }),
    })
    const model = modelRow().querySelector('input') as HTMLInputElement
    expect(toolRow().querySelector('input')?.hasAttribute('disabled')).toBe(false)
    expect(model.disabled).toBe(false)
    expect(screen.getByText(zh.serviceReasonModelUnverified)).toBeTruthy()
    fireEvent.click(model)
    expect((modelRow().querySelector('input') as HTMLInputElement).checked).toBe(false)
  })

  it('cannot newly enable an unverified capability and shows the pending verdict', () => {
    bench()
    const model = modelRow().querySelector('input') as HTMLInputElement
    expect(model.disabled).toBe(true)
    expect(modelRow().textContent).toContain(zh.pending)
    expect(modelRow().textContent).toContain(zh.serviceNotVerified)
  })

  it('keeps an enabled identifier that is no longer discovered, and saves its removal', async () => {
    const { actions } = bench({
      snapshot: snapshot({ ...blockedJson, ownerPolicy: { ...blockedJson.ownerPolicy, enabledServiceIds: ['tool-ffmpeg', 'tool-retired'] } }),
    })
    const row = document.querySelector('[data-service="tool-retired"]') as HTMLElement
    expect(row.textContent).toContain(zh.serviceNotDiscovered)
    fireEvent.click(row.querySelector('input')!)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.save })) })
    expect(actions.savePolicy.mock.calls[0]![0].enabledServiceIds).toEqual(['tool-ffmpeg'])
  })

  it('enables a verified capability that the saved policy did not include', async () => {
    const { actions } = bench({
      snapshot: snapshot({
        ...blockedJson,
        localServices: [...blockedJson.localServices, { id: 'tool-imagemagick', kind: 'tool', name: 'ImageMagick', version: '7.1.1', verification: 'verified', reason: null }],
      }),
    })
    const row = document.querySelector('[data-service="tool-imagemagick"]') as HTMLElement
    expect((row.querySelector('input') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(row.querySelector('input')!)
    expect((document.querySelector('[data-service="tool-imagemagick"] input') as HTMLInputElement).checked).toBe(true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.save })) })
    expect(actions.savePolicy.mock.calls[0]![0].enabledServiceIds).toEqual(['tool-ffmpeg', 'tool-imagemagick'])
  })

  it('submits only once when the owner double-clicks save', async () => {
    const { actions } = bench()
    let release!: (value: boolean) => void
    actions.savePolicy.mockReturnValue(new Promise<boolean>((resolve) => { release = resolve }))
    const button = screen.getByRole('button', { name: zh.save })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(actions.savePolicy).toHaveBeenCalledTimes(1)
    await act(async () => { release(true) })
    expect(screen.getByRole('status').textContent).toBe(zh.saved)
  })

  it('blocks a save whose enabled identifier the host parser would reject', async () => {
    const { actions } = bench({
      snapshot: snapshot({
        ...blockedJson,
        ownerPolicy: { ...blockedJson.ownerPolicy, enabledServiceIds: ['not an id'], nodeRates: [] },
      }),
    })
    expect(document.querySelector('[data-service="not an id"]')?.textContent)
      .toContain(zh.invalidServiceId.replace('{id}', 'not an id'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.save })) })
    expect(actions.savePolicy).not.toHaveBeenCalled()
    expect(document.querySelector('[data-problem="serviceId"]')?.textContent)
      .toBe(zh.invalidServiceId.replace('{id}', 'not an id'))
  })

  it('shows the saved local rate settings as a count without any amount', () => {
    bench()
    expect(screen.getByText(zh.ratesCount.replace('{count}', '1'))).toBeTruthy()
    expect(screen.queryByText(/250/)).toBeNull()
  })

  it('reflects the saving state on the submit control and the fieldset', () => {
    bench({ saving: true })
    expect(screen.getByRole('button', { name: zh.saving })).toHaveProperty('disabled', true)
    expect((document.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    expect((document.querySelector('fieldset') as HTMLFieldSetElement).hasAttribute('disabled')).toBe(true)
  })

  it('disables the fields while the first observation is still loading', () => {
    bench({ snapshot: null, loading: true })
    expect(screen.getByRole('button', { name: zh.refresh })).toHaveProperty('disabled', true)
    expect(screen.getAllByText(zh.noObservationHint)).toHaveLength(2)
  })

  it('asks the host for a fresh observation when the owner clicks refresh', () => {
    const { actions } = bench()
    // The mount effect already observed once; the click asks for another.
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    expect(actions.refresh).toHaveBeenCalledTimes(2)
  })
})

describe('supply navigation glyph', () => {
  it('renders a decorative icon and hides it from assistive technology', () => {
    const { container } = render(<SupplyIcon />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.getAttribute('width')).toBe('20')
  })
})
