// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DesktopDeviceControls } from '../src/client/DesktopDeviceControls.tsx'
import { en } from '../src/client/locales.ts'
import type { DesktopDeviceBridge } from '../src/client/desktop-device-bridge.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

const t: TranslateNS<'settings'> = key => key in en ? en[key as keyof typeof en] : key

describe('desktop device controls', () => {
  it('shows owner choices and keeps power and lock behavior clear', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
    const set = vi.fn(async () => ({ launchAtLogin: true, launchAtLoginAvailable: true, keepAwake: true }))
    const bridge: DesktopDeviceBridge = {
      status: vi.fn(async () => ({ launchAtLogin: false, launchAtLoginAvailable: true, keepAwake: true })),
      set,
    }
    vi.stubGlobal('dshDesktop', { protocolVersion: 1, device: bridge })
    render(<DesktopDeviceControls t={t} />)
    const launch = await screen.findByRole('switch', { name: /Launch at login/ })
    expect(launch.getAttribute('aria-checked')).toBeNull()
    expect(launch).toHaveProperty('checked', false)
    expect(screen.getByRole('switch', { name: /Keep working while open/ })).toHaveProperty('checked', true)
    expect(screen.getByText(/system lock remains in control/)).toBeTruthy()
    fireEvent.click(launch)
    await waitFor(() => { expect(set).toHaveBeenCalledWith('launchAtLogin', true) })
  })

  it('explains that automatic updates install only when work is idle and permits disabling them', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
    const set = vi.fn(async () => ({ launchAtLogin: false, launchAtLoginAvailable: true,
      keepAwake: true, automaticUpdates: false }))
    vi.stubGlobal('dshDesktop', { protocolVersion: 1, device: {
      status: async () => ({ launchAtLogin: false, launchAtLoginAvailable: true,
        keepAwake: true, automaticUpdates: true }), set,
    } satisfies DesktopDeviceBridge })
    render(<DesktopDeviceControls t={t} />)
    const automatic = await screen.findByRole('switch', { name: /Automatically download and install updates/u })
    expect(automatic).toHaveProperty('checked', true)
    expect(screen.getByText(/Busy or unknown work waits/u)).toBeTruthy()
    fireEvent.click(automatic)
    await waitFor(() => { expect(set).toHaveBeenCalledWith('automaticUpdates', false) })
    expect(automatic).toHaveProperty('checked', false)
  })

  it('disables auto-launch in development and is absent outside the Qianshou shell', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
    vi.stubGlobal('dshDesktop', { protocolVersion: 1, device: {
      status: async () => ({ launchAtLogin: false, launchAtLoginAvailable: false, keepAwake: true }),
      set: vi.fn(),
    } satisfies DesktopDeviceBridge })
    const view = render(<DesktopDeviceControls t={t} />)
    expect(await screen.findByRole('switch', { name: /Launch at login/ })).toHaveProperty('disabled', true)
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    view.rerender(<DesktopDeviceControls t={t} />)
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
