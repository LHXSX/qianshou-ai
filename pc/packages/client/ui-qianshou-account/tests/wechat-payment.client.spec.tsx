// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { AccountController, type AccountWechatOrderView, type AccountWechatStartView } from '../src/client/controller.ts'
import { AccountPanel, type AccountPanelProps } from '../src/client/AccountPanel.tsx'
import { zh } from '../src/client/locales.ts'

const signedIn: AccountSnapshot = { phase: 'authenticated', account: { id: '17', username: 'fixture-user' },
  failure: null, restorable: true, verifiedAt: 1, models: [], cloudSelected: false }
const now = Date.now()
const pending = { orderNo: 'PAY_1700000000_A1B2C3D4', amount: '12.34', status: 'pending' as const,
  createdAt: now, expiresAt: now + 15 * 60_000, codeUrl: 'weixin://wxpay/bizpayurl?pr=TEST_ORDER' }
const commerce = { tierLabel: 'Max', remainingSp: 12, windowLimitSp: 600, usedInWindowSp: 10,
  balanceYuan: '1.00', plans: [], quote: null, notice: null }
const ok = <T,>(value: T) => ({ ok: true as const, value })

function fixture(channelAvailable: boolean, rechargeIdempotency = true) {
  const remote = {
    state: vi.fn(async () => ok(signedIn)),
    billing: vi.fn(async () => ok(commerce)),
    wechatChannel: vi.fn(async () => ok({ available: channelAvailable, rechargeIdempotency })),
    startWechatRecharge: vi.fn<(amount: string, idempotencyKey: string, replay?: boolean) =>
      Promise<{ ok: true; value: AccountWechatStartView }>>(async () => ok({ kind: 'ready', order: pending })),
    wechatOrder: vi.fn<(orderNo: string) => Promise<{ ok: true; value: AccountWechatOrderView }>>(
      async () => ok({ ...pending, status: 'paid' as const, codeUrl: null })),
    wechatOrderRefresh: vi.fn<(orderNo: string) => Promise<{ ok: true; value: AccountWechatOrderView }>>(
      async () => ok({ ...pending, status: 'paid' as const,
        providerState: 'SUCCESS' as const, codeUrl: null })),
    wechatOrders: vi.fn(async () => ok([pending])),
    wechatOrderPayment: vi.fn(async () => ok(pending)),
  }
  const controller = new AccountController({ emit: vi.fn(), remote: { qianshouAccount: remote } } as unknown as Context)
  const props = { controller, useAccount: bindSnapshotSelector(controller.store),
    t: (key: keyof typeof zh, params?: Record<string, string>) => Object.entries(params ?? {})
      .reduce((copy, [name, value]) => copy.replaceAll(`{${name}}`, value), zh[key]) } as AccountPanelProps
  return { remote, props, controller }
}

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: unknown, task: () => Promise<void>) => task(),
  } })
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('PC account WeChat QR recharge', () => {
  it('checks the real channel and prevents a new order when unavailable', async () => {
    const { remote, props } = fixture(false)
    render(<AccountPanel {...props} />)
    await waitFor(() => { expect(screen.getByText('fixture-user')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /充值/ }))
    await waitFor(() => { expect(remote.wechatChannel).toHaveBeenCalledTimes(1) })
    expect(screen.getByRole('button', { name: zh.wechatCreate }).hasAttribute('disabled')).toBe(true)
    expect(remote.startWechatRecharge).not.toHaveBeenCalled()
  })

  it('creates once, keeps the original order, and shows paid only after provider refresh', async () => {
    const { remote, props } = fixture(true)
    render(<AccountPanel {...props} />)
    await waitFor(() => { expect(screen.getByText('fixture-user')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /充值/ }))
    await waitFor(() => { expect(remote.wechatChannel).toHaveBeenCalledTimes(1) })
    fireEvent.change(screen.getByLabelText(zh.rechargeAmount), { target: { value: '12.34' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wechatCreate }))
    await waitFor(() => { expect(remote.startWechatRecharge).toHaveBeenCalledWith('12.34',
      expect.stringMatching(/^[a-f0-9-]{36}$/u), false) })
    await waitFor(() => { expect(screen.getByText(`订单 ${pending.orderNo} · ¥12.34`)).toBeTruthy() })
    await waitFor(() => { expect((screen.getByAltText(zh.wechatScan) as HTMLImageElement).src)
      .toMatch(/^data:image\/svg\+xml;charset=utf-8,/u) })
    expect(localStorage.getItem('qianshou.pc.wechat-recharge.17')).toContain(pending.orderNo)
    expect(remote.wechatOrderRefresh).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.wechatVerify }))
    await waitFor(() => { expect(remote.wechatOrderRefresh).toHaveBeenCalledWith(pending.orderNo) })
    await waitFor(() => { expect(screen.getAllByText(zh.wechatPaid).length).toBeGreaterThan(0) })
    expect(remote.startWechatRecharge).toHaveBeenCalledTimes(1)
  })

  it('keeps an expired order locked until WeChat confirms CLOSED', async () => {
    const { remote, props, controller } = fixture(true)
    render(<AccountPanel {...props} />)
    await waitFor(() => { expect(screen.getByText('fixture-user')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /充值/ }))
    await waitFor(() => { expect(remote.wechatChannel).toHaveBeenCalledTimes(1) })
    fireEvent.change(screen.getByLabelText(zh.rechargeAmount), { target: { value: '12.34' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wechatCreate }))
    await waitFor(() => { expect(remote.startWechatRecharge).toHaveBeenCalledTimes(1) })

    remote.wechatOrder.mockResolvedValue(ok({ ...pending, status: 'expired', codeUrl: null }))
    await controller.loadWechatOrder(pending.orderNo)
    await waitFor(() => { expect(screen.getByText(zh.wechatUnsettled)).toBeTruthy() })
    expect(localStorage.getItem('qianshou.pc.wechat-recharge.17')).toContain(pending.orderNo)
    expect(screen.queryByRole('button', { name: zh.wechatNewOrder })).toBeNull()
    expect(remote.startWechatRecharge).toHaveBeenCalledTimes(1)

    remote.wechatOrderRefresh.mockResolvedValueOnce(ok({ ...pending, status: 'expired',
      providerState: 'NOTPAY', codeUrl: null }))
    fireEvent.click(screen.getByRole('button', { name: zh.wechatVerify }))
    await waitFor(() => { expect(remote.wechatOrderRefresh).toHaveBeenCalledTimes(1) })
    expect(localStorage.getItem('qianshou.pc.wechat-recharge.17')).toContain(pending.orderNo)
    expect(screen.queryByRole('button', { name: zh.wechatNewOrder })).toBeNull()

    remote.wechatOrderRefresh.mockResolvedValueOnce(ok({ ...pending, status: 'expired',
      providerState: 'CLOSED', codeUrl: null }))
    fireEvent.click(screen.getByRole('button', { name: zh.wechatVerify }))
    await waitFor(() => { expect(screen.getByText(zh.wechatConfirmedClosed)).toBeTruthy() })
    await waitFor(() => { expect(localStorage.getItem('qianshou.pc.wechat-recharge.17')).toBeNull() })
    expect(screen.getByRole('button', { name: zh.wechatNewOrder })).toBeTruthy()
    expect(remote.startWechatRecharge).toHaveBeenCalledTimes(1)
  })

  it('does not lose a signed CLOSED verdict when a late status-only GET arrives', async () => {
    const { remote, props, controller } = fixture(true)
    render(<AccountPanel {...props} />)
    await waitFor(() => { expect(screen.getByText('fixture-user')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /充值/ }))
    await waitFor(() => { expect(remote.wechatChannel).toHaveBeenCalledTimes(1) })
    fireEvent.change(screen.getByLabelText(zh.rechargeAmount), { target: { value: '12.34' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wechatCreate }))
    await waitFor(() => { expect(remote.startWechatRecharge).toHaveBeenCalledTimes(1) })
    remote.wechatOrderRefresh.mockResolvedValueOnce(ok({ ...pending, providerState: 'CLOSED' as const, codeUrl: null }))
    await controller.refreshWechatOrder(pending.orderNo)
    await waitFor(() => { expect(screen.getByText(zh.wechatConfirmedClosed)).toBeTruthy() })
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.wechatNewOrder })).toBeTruthy() })
    remote.wechatOrder.mockResolvedValueOnce(ok({ ...pending, codeUrl: null }))
    await controller.loadWechatOrder(pending.orderNo)
    expect(controller.store.getSnapshot().wechatOrder?.providerState).toBe('CLOSED')
    expect(screen.getByText(zh.wechatConfirmedClosed)).toBeTruthy()
    expect(screen.queryByAltText(zh.wechatScan)).toBeNull()
  })

  it('persists one key before a timed-out POST and replays that key after remount', async () => {
    const first = fixture(true)
    first.remote.startWechatRecharge.mockRejectedValueOnce(new Error('timeout'))
    const mounted = render(<AccountPanel {...first.props} />)
    await waitFor(() => { expect(screen.getByText('fixture-user')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /充值/ }))
    await waitFor(() => { expect(first.remote.wechatChannel).toHaveBeenCalledTimes(1) })
    fireEvent.change(screen.getByLabelText(zh.rechargeAmount), { target: { value: '12.34' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wechatCreate }))
    await waitFor(() => { expect(first.remote.startWechatRecharge).toHaveBeenCalledTimes(1) })
    const originalKey = first.remote.startWechatRecharge.mock.calls[0]?.[1]
    expect(originalKey).toMatch(/^[a-f0-9-]{36}$/u)
    expect(JSON.parse(localStorage.getItem('qianshou.pc.wechat-recharge.17') ?? '{}').idempotencyKey)
      .toBe(originalKey)
    mounted.unmount()

    const restarted = fixture(true)
    render(<AccountPanel {...restarted.props} />)
    await waitFor(() => { expect(screen.getByText('fixture-user')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /充值/ }))
    await waitFor(() => { expect(restarted.remote.wechatChannel).toHaveBeenCalledTimes(1) })
    expect(screen.getByRole('button', { name: zh.wechatCreate }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh.wechatRecover }))
    await waitFor(() => { expect(restarted.remote.startWechatRecharge)
      .toHaveBeenCalledWith('12.34', originalKey, true) })
    await waitFor(() => { expect(screen.getByText(`订单 ${pending.orderNo} · ¥12.34`)).toBeTruthy() })
  })

  it('never re-POSTs an unknown result to an old server with no idempotency capability', async () => {
    const { remote, props } = fixture(true, false)
    remote.startWechatRecharge.mockResolvedValueOnce(ok({ kind: 'unknown' as const, orderNo: null }))
    render(<AccountPanel {...props} />)
    await waitFor(() => { expect(screen.getByText('fixture-user')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /充值/ }))
    await waitFor(() => { expect(remote.wechatChannel).toHaveBeenCalledTimes(1) })
    fireEvent.change(screen.getByLabelText(zh.rechargeAmount), { target: { value: '12.34' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wechatCreate }))
    await waitFor(() => { expect(remote.startWechatRecharge).toHaveBeenCalledTimes(1) })
    fireEvent.click(screen.getByRole('button', { name: zh.wechatRecover }))
    await waitFor(() => { expect(remote.wechatOrders).toHaveBeenCalledTimes(1) })
    expect(remote.startWechatRecharge).toHaveBeenCalledTimes(1)
  })

  it('keeps the intent locked and surfaces a 409 conflict without sending a third POST', async () => {
    const { remote, props } = fixture(true)
    remote.wechatOrders.mockResolvedValue(ok([]))
    remote.startWechatRecharge.mockResolvedValueOnce(ok({ kind: 'unknown' as const, orderNo: null }))
      .mockResolvedValueOnce(ok({ kind: 'conflict' as const }))
    render(<AccountPanel {...props} />)
    await waitFor(() => { expect(screen.getByText('fixture-user')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /充值/ }))
    await waitFor(() => { expect(remote.wechatChannel).toHaveBeenCalledTimes(1) })
    fireEvent.change(screen.getByLabelText(zh.rechargeAmount), { target: { value: '12.34' } })
    fireEvent.click(screen.getByRole('button', { name: zh.wechatCreate }))
    await waitFor(() => { expect(remote.startWechatRecharge).toHaveBeenCalledTimes(1) })
    fireEvent.click(screen.getByRole('button', { name: zh.wechatRecover }))
    await waitFor(() => { expect(screen.getByText(zh.wechatConflict)).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh.wechatRecover }))
    await waitFor(() => { expect(remote.wechatOrders).toHaveBeenCalledTimes(1) })
    expect(remote.startWechatRecharge).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem('qianshou.pc.wechat-recharge.17')).toContain('"conflict":true')
  })
})
