// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { CompanionSetup } from '../src/client/CompanionSetup.tsx'
import { DevicesController, type DeviceState } from '../src/client/controller.ts'
import { remoteCoordinatorAddress } from '../src/client/invitation.ts'
import { zh } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const release = { id: 'darwin-arm64' as const, version: '0.1.0', filename: 'qianshou-companion-0.1.0-darwin-arm64.zip',
  bytes: 123, sha256: 'a'.repeat(64), validation: 'local-mac-verified' as const, href: '/api/qianshou/companion-downloads/darwin-arm64' }
function state(): DeviceState {
  return { devices: [], jobs: [], loading: false, busy: false, error: null,
    pairing: { code: 'SYNTHETIC_TEST_CODE', expiresAt: new Date(Date.now() + 60000).toISOString() },
    releases: [release], releasesLoading: false, releasesError: null }
}
describe('companion setup address boundary', () => {
  it.each(['http://example.com', 'https://127.0.0.1:3081', 'https://127.20.3.4', 'https://localhost',
    'https://x.localhost', 'https://[::1]', 'https://0.0.0.0', 'https://[::ffff:127.0.0.1]',
    'https://user:password@example.com', 'https://example.com/?token=secret', 'https://example.com/#token=secret', 'https://example.com/api'])('does not share %s', (value) => {
    expect(remoteCoordinatorAddress(value)).toBeNull()
  })
  it('normalizes an HTTPS origin while leaving reachability explicitly unverified', () => {
    expect(remoteCoordinatorAddress(' https://EXAMPLE.com:443/ ')).toBe('https://example.com')
  })
})
describe('companion setup view', () => {
  it('offers only real authenticated archives and requires a non-loopback address before copying', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const view = render(<CompanionSetup state={state()} reload={vi.fn()} t={makeTranslate(zh, commonZh)} />)
    expect(view.getAllByRole('link', { name: zh.downloadArchive })).toHaveLength(1)
    expect(view.getByRole('link', { name: zh.downloadArchive }).getAttribute('href')).toBe(release.href)
    const button = view.getByRole('button', { name: zh.copyInvite }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(view.getByRole('textbox', { name: zh.address }), { target: { value: 'https://controller.example' } })
    expect(view.getByText(zh.addressUnverified)).toBeTruthy()
    fireEvent.click(button)
    await waitFor(() => { expect(writeText).toHaveBeenCalledOnce() })
    const copied = writeText.mock.calls[0]?.[0]
    expect(copied).toContain('https://controller.example')
    expect(copied).toContain('SYNTHETIC_TEST_CODE')
    expect(copied).toContain(release.filename)
    expect(copied).toContain(release.sha256)
    expect(copied).toContain(zh.downloadPrivate)
    expect(copied).toContain(zh.addressUnverified)
    expect(copied).not.toContain('/api/qianshou')
    expect(copied).not.toContain('127.0.0.1')
  })
  it.each([
    ['darwin-arm64', 'macInstall'], ['win32-x64', 'windowsInstall'], ['linux-x64', 'linuxInstall'],
  ] as const)('copies the public setup guide for %s without a staged archive', async (target, installKey) => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const view = render(<CompanionSetup state={{ ...state(), releases: [] }} reload={vi.fn()} t={makeTranslate(zh, commonZh)} />)
    const official = view.getByRole('link', { name: `${zh.officialDownload} ↗` })
    expect(official.getAttribute('href')).toBe('https://qianshousuanli.com/#/downloads#qianshou-agent')
    expect(view.queryByRole('link', { name: zh.downloadArchive })).toBeNull()
    fireEvent.change(view.getByRole('combobox', { name: zh.recipientPlatform }), { target: { value: target } })
    const button = view.getByRole('button', { name: zh.copyInvite }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(view.getByRole('textbox', { name: zh.address }), { target: { value: 'https://controller.example' } })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => { expect(writeText).toHaveBeenCalledOnce() })
    const copied = writeText.mock.calls[0]?.[0]
    expect(copied).toContain(official.getAttribute('href'))
    expect(copied).toContain(zh[installKey])
    expect(copied).toContain('SYNTHETIC_TEST_CODE')
    expect(copied).toContain(zh.invitePermissions)
    expect(copied).not.toContain(zh.downloadPrivate)
    expect(copied).not.toContain(release.filename)
    expect(copied).not.toContain('/api/qianshou')
  })
  it('never copies an expired code even when the unchanged view still shows its old button state', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const now = Date.now()
    const view = render(<CompanionSetup state={{ ...state(), releases: [] }} reload={vi.fn()} t={makeTranslate(zh, commonZh)} />)
    fireEvent.change(view.getByRole('textbox', { name: zh.address }), { target: { value: 'https://controller.example' } })
    vi.spyOn(Date, 'now').mockReturnValue(now + 120000)
    fireEvent.click(view.getByRole('button', { name: zh.copyInvite }))
    expect(writeText).not.toHaveBeenCalled()
  })
  it('keeps copy unavailable after pairing expiry and surfaces clipboard failure', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => { throw new Error('permission denied') })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const current = state()
    const view = render(<CompanionSetup state={current} reload={vi.fn()} t={makeTranslate(zh, commonZh)} />)
    fireEvent.change(view.getByRole('textbox', { name: zh.address }), { target: { value: 'https://controller.example' } })
    fireEvent.click(view.getByRole('button', { name: zh.copyInvite }))
    await view.findByRole('alert')
    expect(view.getByText(zh.copyFailed)).toBeTruthy()
    view.rerender(<CompanionSetup state={{ ...current, pairing: null }} reload={vi.fn()} t={makeTranslate(zh, commonZh)} />)
    expect((view.getByRole('button', { name: zh.copyInvite }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('rejects external catalog links and retains authentication errors', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ releases: [{ ...release, href: 'https://untrusted.example' }], unavailable: [] }))
      .mockResolvedValueOnce(Response.json({ error: 'UNAUTHENTICATED' }, { status: 401 }))
    const controller = new DevicesController(transport)
    await controller.loadReleases()
    expect(controller.store.getSnapshot().releases).toEqual([])
    expect(controller.store.getSnapshot().releasesError).toBe('INVALID_RELEASE_CATALOG')
    await controller.loadReleases()
    expect(controller.store.getSnapshot().releasesError).toBe('UNAUTHENTICATED')
    controller.dispose()
  })
})
