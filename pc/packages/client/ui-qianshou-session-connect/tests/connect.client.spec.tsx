// @vitest-environment jsdom
/** Owner lifecycle checks with controlled RPC responses; no real secret, account or model. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConnectionGrantCreated, ConnectionGrantInput, ConnectionOwnerState } from '@deepseek-ai/dsh-api-remotes/client'
import { ConnectEntry, type ConnectEntryProps } from '../src/client/ConnectEntry.tsx'
import { zh } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'

const sid = 'synthetic-session' as ConnectEntryProps['sessionId']
const metadata: ConnectionOwnerState = { grants: [], available: true, owner: 'local-device', origin: 'http://127.0.0.1:1234', maxDurationMinutes: 1440 }
// Both ids null: the presentation is exercised on an unbound link, the grant any bearer holder may present.
const created: ConnectionGrantCreated = { grant: { id: 'synthetic-grant', sessionId: sid, label: '合成手机', mode: 'read', createdAt: Date.now(), expiresAt: Date.now() + 60000, revoked: false, lastAccessAt: null, acceptedCommands: 0, pcId: null, deviceId: null }, path: '/qianshou-connect/#synthetic-not-a-real-secret' }
function fixture(origin = 'main') {
  const state = vi.fn(async () => metadata), create = vi.fn(async (_input: ConnectionGrantInput) => created), revoke = vi.fn(async () => {})
  const sessions = createSnapshotStore({ byId: { [sid]: { id: sid, origin } } })
  const props = { sessionId: sid, state, create, revoke, useSessions: bindSnapshotSelector(sessions),
    t: (key: keyof typeof zh) => zh[key],
  } as ConnectEntryProps
  return { props, state, create, revoke }
}
afterEach(() => { cleanup(); vi.unstubAllEnvs() })
describe('explicit owner authorization presentation', () => {
  it('shows the true local scope and one view-only action without creating on open', async () => {
    const f = fixture(), { container } = render(<ConnectEntry {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.title }))
    await screen.findByText(zh.localDevice)
    expect(screen.getByRole('region', { name: zh.reachabilityTitle }).textContent).toContain(zh.localOnly)
    expect(screen.getByRole('button', { name: zh.createRead })).toBeTruthy()
    expect(screen.getByText(zh.advanced).closest('details')?.open).toBe(false)
    expect(screen.getByText(/连接记录 · 0/).closest('details')?.open).toBe(false)
    expect(screen.getByLabelText<HTMLSelectElement>(zh.mode).value).toBe('read')
    expect(f.create).not.toHaveBeenCalled(); expect(screen.getByText(zh.description)).toBeTruthy()
    expect(container.textContent).toContain(zh.title)
  })
  it('creates the default read-only grant in one click and shows the returned link until close', async () => {
    const f = fixture(); render(<ConnectEntry {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.title })); await screen.findByText(zh.localDevice)
    fireEvent.click(screen.getByRole('button', { name: zh.createRead }))
    await screen.findByLabelText(zh.link)
    expect(f.create).toHaveBeenCalledWith({ sessionId: sid, label: zh.defaultLabel, mode: 'read', durationMinutes: 60 })
    expect(screen.getByRole('region', { name: zh.createdTitle })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.copy })).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.createRead })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(screen.queryByLabelText(zh.link)).toBeNull(); expect(f.revoke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.title })); await screen.findByText(zh.localDevice)
    expect(screen.queryByLabelText(zh.link)).toBeNull()
  })
  it('copies the one-time link as the first success action', async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writeText = vi.fn(async (_value: string) => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      const f = fixture(); render(<ConnectEntry {...f.props} />)
      fireEvent.click(screen.getByRole('button', { name: zh.title })); await screen.findByText(zh.localDevice)
      fireEvent.click(screen.getByRole('button', { name: zh.createRead })); await screen.findByLabelText(zh.link)
      fireEvent.click(screen.getByRole('button', { name: zh.copy }))
      await waitFor(() => { expect(writeText).toHaveBeenCalledWith('http://127.0.0.1:1234/qianshou-connect/#synthetic-not-a-real-secret') })
      expect(screen.getByRole('status').textContent).toBe(zh.copied)
    } finally {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  })
  it('distinguishes configured HTTPS from verified external reachability', async () => {
    const f = fixture()
    f.state.mockResolvedValue({ ...metadata, origin: 'https://connect.example.test' })
    render(<ConnectEntry {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.title }))
    await screen.findByText(zh.httpsConfigured)
    expect(screen.getByRole('region', { name: zh.reachabilityTitle }).textContent).toContain(zh.httpsCheck)
    expect(screen.queryByText(zh.localOnly)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.createRead }))
    const link = await screen.findByLabelText<HTMLTextAreaElement>(zh.link)
    expect(link.value).toMatch(/^https:\/\/connect\.example\.test\/qianshou-connect\//u)
  })
  it('shows a retry when owner state cannot load, without exposing private errors', async () => {
    const f = fixture()
    f.state.mockRejectedValueOnce(new Error('private-host-diagnostic'))
    render(<ConnectEntry {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.title }))
    await screen.findByRole('button', { name: zh.retry })
    expect(screen.getByRole('alert').textContent).toContain(zh.failed)
    expect(screen.queryByText('private-host-diagnostic')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await screen.findByText(zh.localDevice)
    expect(f.state).toHaveBeenCalledTimes(2)
  })
  it('warns before explicit text access and never changes a Session permission or model', async () => {
    const f = fixture(); render(<ConnectEntry {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.title })); await screen.findByText(zh.localDevice)
    fireEvent.click(screen.getByText(zh.advanced))
    fireEvent.change(screen.getByLabelText(zh.mode), { target: { value: 'text' } })
    expect(screen.getByText(zh.permission).closest('details')).toBeNull()
    fireEvent.click(screen.getByText(zh.advanced))
    expect(screen.getByText(zh.permission)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh.label), { target: { value: '合成手机' } })
    fireEvent.click(screen.getByRole('button', { name: zh.createText }))
    await waitFor(() => { expect(f.create).toHaveBeenCalledWith({ sessionId: sid, label: '合成手机', mode: 'text', durationMinutes: 60 }) })
  })
  it('discards late secrets after closing while the explicit create action is pending', async () => {
    const f = fixture(), held = Promise.withResolvers<ConnectionGrantCreated>()
    f.create.mockReturnValueOnce(held.promise); render(<ConnectEntry {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.title })); await screen.findByText(zh.localDevice)
    fireEvent.click(screen.getByRole('button', { name: zh.createRead }))
    fireEvent.click(screen.getByRole('button', { name: zh.close })); held.resolve(created)
    await Promise.resolve()
    expect(screen.queryByLabelText(zh.link)).toBeNull(); expect(f.revoke).not.toHaveBeenCalled()
  })
  it('revokes only the selected grant and refreshes its non-secret status', async () => {
    const f = fixture(); f.state.mockResolvedValue({ ...metadata, grants: [created.grant] }); render(<ConnectEntry {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.title })); await screen.findByText(zh.localDevice)
    fireEvent.click(screen.getByText(/连接记录 · 1/))
    await screen.findByRole('button', { name: zh.revoke })
    fireEvent.click(screen.getByRole('button', { name: zh.revoke }))
    await waitFor(() => { expect(f.revoke).toHaveBeenCalledWith(sid, created.grant.id) })
    await waitFor(() => { expect(f.state).toHaveBeenCalledTimes(2) })
  })
  it('omits blank binding ids and passes trimmed valid deviceId and pcId', async () => {
    const f = fixture(); render(<ConnectEntry {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.title })); await screen.findByText(zh.localDevice)
    fireEvent.click(screen.getByText(zh.advanced))
    fireEvent.click(screen.getByText(zh.deviceSettings))
    fireEvent.change(screen.getByLabelText(zh.label), { target: { value: '合成手机' } })
    fireEvent.change(screen.getByLabelText(zh.deviceId), { target: { value: '   ' } })
    fireEvent.change(screen.getByLabelText(zh.pcId), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: zh.createRead }))
    await screen.findByLabelText(zh.link)
    expect(f.create).toHaveBeenCalledWith({ sessionId: sid, label: '合成手机', mode: 'read', durationMinutes: 60 })
    expect(f.create.mock.calls[0]![0]).not.toHaveProperty('deviceId')
    expect(f.create.mock.calls[0]![0]).not.toHaveProperty('pcId')
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    fireEvent.click(screen.getByRole('button', { name: zh.title })); await screen.findByText(zh.localDevice)
    fireEvent.click(screen.getByText(zh.advanced))
    fireEvent.click(screen.getByText(zh.deviceSettings))
    fireEvent.change(screen.getByLabelText(zh.label), { target: { value: '合成手机' } })
    fireEvent.change(screen.getByLabelText(zh.deviceId), { target: { value: '  phone-1  ' } })
    fireEvent.change(screen.getByLabelText(zh.pcId), { target: { value: ' pc-owner ' } })
    fireEvent.click(screen.getByRole('button', { name: zh.createRead }))
    await waitFor(() => {
      expect(f.create).toHaveBeenLastCalledWith({
        sessionId: sid, label: '合成手机', mode: 'read', durationMinutes: 60, deviceId: 'phone-1', pcId: 'pc-owner',
      })
    })
  })
  it('rejects an illegal device id without calling create', async () => {
    const f = fixture(); render(<ConnectEntry {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh.title })); await screen.findByText(zh.localDevice)
    fireEvent.click(screen.getByText(zh.advanced))
    fireEvent.click(screen.getByText(zh.deviceSettings))
    fireEvent.change(screen.getByLabelText(zh.label), { target: { value: '合成手机' } })
    fireEvent.change(screen.getByLabelText(zh.deviceId), { target: { value: 'bad\u0001id' } })
    fireEvent.click(screen.getByRole('button', { name: zh.createRead }))
    expect(f.create).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(zh.invalidId)
  })
  it('shows no connection action in a delegated child Session', () => {
    const f = fixture('subagent'); render(<ConnectEntry {...f.props} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('activates harmlessly without its Remote in non-Qianshou profile', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'default')
    const ctx = new Context(); ctx.provide('slots', {} as never); ctx.provide('locale', {} as never); ctx.provide('remote', {} as never)
    try { const fiber = ctx.plugin({ apply, inject }); await fiber.await(); expect(fiber.state).toBe(FiberState.ACTIVE) }
    finally { await ctx.fiber.dispose() }
  })
})
