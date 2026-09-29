// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { RelayController, type RelayBridge, type RelayState, type RelayStatus } from '../src/client/relay-controller.ts'
import { RelayConnectionSection } from '../src/client/RelayConnectionSection.tsx'
import { CompanionSetup } from '../src/client/CompanionSetup.tsx'
import { zh } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })
const t = makeTranslate(zh, commonZh)
const disabled: RelayStatus = { configured: true, enabled: false, phase: 'disabled', endpoint: 'https://203.0.113.20:24443', error: null }
const online: RelayStatus = { ...disabled, enabled: true, phase: 'online' }
const state = (status = disabled): RelayState => ({ available: true, busy: false, status, error: null })

it('shows desktop upgrade guidance without exposing an inoperative browser enable button', () => {
  const view = render(<RelayConnectionSection state={{ ...state(), available: false }} act={vi.fn()} t={t} />)
  expect(view.getByText(zh.relayBrowserHint)).toBeTruthy()
  expect(view.queryByRole('button', { name: zh.relayEnable })).toBeNull()
  expect(view.container.textContent).toMatchSnapshot()
})

it('requires an actual online receipt before copying the endpoint and disables duplicate operations', async () => {
  const writeText = vi.fn(async () => {}), act = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const view = render(<RelayConnectionSection state={state()} act={act} t={t} />)
  fireEvent.click(view.getByRole('button', { name: zh.relayCopyAddress }))
  expect(writeText).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: zh.relayEnable }))
  expect(act).toHaveBeenCalledWith('enable')
  view.rerender(<RelayConnectionSection state={{ ...state(online), busy: true }} act={act} t={t} />)
  expect((view.getByRole('button', { name: zh.relayDisable }) as HTMLButtonElement).disabled).toBe(true)
  expect((view.getByRole('button', { name: zh.relayImport }) as HTMLButtonElement).disabled).toBe(true)
  view.rerender(<RelayConnectionSection state={state(online)} act={act} t={t} />)
  fireEvent.click(view.getByRole('button', { name: zh.relayCopyAddress }))
  await waitFor(() => { expect(writeText).toHaveBeenCalledExactlyOnceWith(online.endpoint) })
  expect(view.container.textContent).toMatchSnapshot()
  fireEvent.click(view.getByRole('button', { name: zh.relayDisable }))
  expect(act).toHaveBeenLastCalledWith('disable')
})

it('localizes native errors rather than rendering raw error strings', () => {
  const view = render(<RelayConnectionSection state={{ ...state(), error: 'unexpected secret-looking wire text' }} act={vi.fn()} t={t} />)
  expect(view.getByRole('alert').textContent).toBe(zh.relayFailedHint)
  expect(view.container.textContent).not.toContain('secret-looking')
  view.rerender(<RelayConnectionSection state={{ ...state(), error: 'SECURE_STORAGE_UNAVAILABLE' }} act={vi.fn()} t={t} />)
  expect(view.getByRole('alert').textContent).toBe(zh.relayStorage)
})

it('native controller does not start on mount and settles explicit enable/disable without private fields', async () => {
  let current = disabled
  const bridge: RelayBridge = {
    status: vi.fn(async () => ({ ok: true, status: current })),
    importConfig: vi.fn(async () => ({ ok: true, status: current })),
    setEnabled: vi.fn(async (enabled) => { current = enabled ? online : disabled; return { ok: true, status: current } }) }
  const controller = new RelayController(bridge)
  const detach = controller.attach()
  await waitFor(() => { expect(controller.store.getSnapshot().status.phase).toBe('disabled') })
  expect(bridge.setEnabled).not.toHaveBeenCalled()
  await controller.act('enable')
  expect(controller.store.getSnapshot().status.phase).toBe('online')
  await controller.act('disable')
  expect(controller.store.getSnapshot().status.phase).toBe('disabled')
  detach(); controller.dispose()
  await controller.act('enable')
  expect(bridge.setEnabled).toHaveBeenCalledTimes(2)
})

it('invitation uses the verified relay endpoint only after an explicit choice and keeps pairing required', () => {
  const view = render(<CompanionSetup state={{ devices: [], jobs: [], loading: false, busy: false, error: null, pairing: null,
    releases: [], releasesLoading: false, releasesError: null }} reload={vi.fn()} relayAddress={online.endpoint} t={t} />)
  expect((view.getByRole('textbox', { name: zh.address }) as HTMLInputElement).value).toBe('')
  fireEvent.click(view.getByRole('button', { name: zh.relayUseAddress }))
  expect((view.getByRole('textbox', { name: zh.address }) as HTMLInputElement).value).toBe(online.endpoint)
  expect((view.getByRole('button', { name: zh.copyInvite }) as HTMLButtonElement).disabled).toBe(true)
  expect(view.getByText(zh.addressUnverified)).toBeTruthy()
})
