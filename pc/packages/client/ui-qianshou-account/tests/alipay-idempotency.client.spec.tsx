// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { AccountController, type AccountAlipayStartView } from '../src/client/controller.ts'
import { AccountPanel, type AccountPanelProps } from '../src/client/AccountPanel.tsx'
import { zh } from '../src/client/locales.ts'

const now = Date.now()
const order = { orderNo: 'PAY_1700000000_A1B2C3D4', amount: '12.34', status: 'pending' as const,
  createdAt: now, expiresAt: now + 15 * 60_000 }
const payment = { action: 'https://openapi.alipay.com/gateway.do?charset=utf-8',
  fields: [{ name: 'biz_content', value: '{"out_trade_no":"PAY_1700000000_A1B2C3D4"}' },
    { name: 'sign', value: 'signed' }] }
const commerce = { tierLabel: 'Max', remainingSp: 12, windowLimitSp: 600, usedInWindowSp: 10,
  balanceYuan: '1.00', plans: [], quote: null, notice: null }
const ok = <T,>(value: T) => ({ ok: true as const, value })

function fixture(id = '17', idempotency = true) {
  const signedIn: AccountSnapshot = { phase: 'authenticated', account: { id, username: `fixture-${id}` },
    failure: null, restorable: true, verifiedAt: 1, models: [], cloudSelected: false }
  const remote = {
    state: vi.fn(async () => ok(signedIn)), billing: vi.fn(async () => ok(commerce)),
    wechatChannel: vi.fn(async () => ok({ available: false, rechargeIdempotency: idempotency })),
    startRecharge: vi.fn<(amount: string, idempotencyKey: string, replay?: boolean) =>
      Promise<{ ok: true; value: AccountAlipayStartView }>>(async () => ok({ kind: 'ready', order, payment })),
    alipayOrder: vi.fn(async () => ok({ ...order, status: 'paid' as const })),
    alipayOrders: vi.fn(async () => ok([])), alipayOrderPayment: vi.fn(async () => ok(payment)),
  }
  const controller = new AccountController({ emit: vi.fn(), remote: { qianshouAccount: remote } } as unknown as Context)
  const props = { controller, useAccount: bindSnapshotSelector(controller.store),
    t: (key: keyof typeof zh, params?: Record<string, string>) => Object.entries(params ?? {})
      .reduce((copy, [name, value]) => copy.replaceAll(`{${name}}`, value), zh[key]) } as AccountPanelProps
  return { remote, controller, props }
}

async function openAlipayTab() {
  fireEvent.click(screen.getByRole('button', { name: /充值/ }))
  fireEvent.click(screen.getByRole('button', { name: zh.alipayPay }))
}

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: unknown, task: () => Promise<void>) => task(),
  } })
})
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

describe('PC Alipay recharge intent', () => {
  it('writes a random key before the first POST, opens only its signed form and keeps the order locked', async () => {
    const { remote, props } = fixture()
    render(<AccountPanel {...props} />)
    await waitFor(() => { expect(screen.getByText('fixture-17')).toBeTruthy() })
    await openAlipayTab()
    fireEvent.change(screen.getByLabelText(zh.rechargeAmount), { target: { value: '12.34' } })
    fireEvent.click(screen.getByRole('button', { name: zh.rechargePay }))
    fireEvent.click(screen.getByRole('button', { name: zh.rechargePay }))
    await waitFor(() => { expect(remote.startRecharge).toHaveBeenCalledTimes(1) })
    const key = remote.startRecharge.mock.calls[0]?.[1]
    expect(key).toMatch(/^[a-f0-9-]{36}$/u)
    expect(remote.startRecharge).toHaveBeenCalledWith('12.34', key, false)
    expect(JSON.parse(localStorage.getItem('qianshou.pc.alipay-recharge.17') ?? '{}'))
      .toMatchObject({ amount: '12.34', orderNo: order.orderNo, idempotencyKey: key })
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: zh.rechargePay }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh.alipayReopen }))
    await waitFor(() => { expect(remote.alipayOrderPayment).toHaveBeenCalledWith(order.orderNo, '12.34') })
    expect(remote.startRecharge).toHaveBeenCalledTimes(1)
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: zh.alipayCheck }))
    await waitFor(() => { expect(remote.alipayOrder).toHaveBeenCalledWith(order.orderNo) })
    await waitFor(() => { expect(localStorage.getItem('qianshou.pc.alipay-recharge.17')).toBeNull() })
    expect(screen.getByText(zh.alipayPaid)).toBeTruthy()
  })

  it('reuses the same key after timeout and restart instead of creating a second intent', async () => {
    const first = fixture()
    first.remote.startRecharge.mockRejectedValueOnce(new Error('timeout'))
    const mounted = render(<AccountPanel {...first.props} />)
    await waitFor(() => { expect(screen.getByText('fixture-17')).toBeTruthy() })
    await openAlipayTab()
    fireEvent.change(screen.getByLabelText(zh.rechargeAmount), { target: { value: '12.34' } })
    fireEvent.click(screen.getByRole('button', { name: zh.rechargePay }))
    await waitFor(() => { expect(first.remote.startRecharge).toHaveBeenCalledTimes(1) })
    const key = first.remote.startRecharge.mock.calls[0]?.[1]
    expect(JSON.parse(localStorage.getItem('qianshou.pc.alipay-recharge.17') ?? '{}').idempotencyKey).toBe(key)
    mounted.unmount()

    const restarted = fixture()
    render(<AccountPanel {...restarted.props} />)
    await waitFor(() => { expect(screen.getByText('fixture-17')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /充值/ }))
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.alipayRecover })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh.alipayRecover }))
    await waitFor(() => { expect(restarted.remote.startRecharge).toHaveBeenCalledWith('12.34', key, true) })
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('qianshou.pc.alipay-recharge.17')).toContain(order.orderNo)
  })

  it('uses history on an old server with no idempotency capability and does not re-POST', async () => {
    const { remote, props } = fixture('17', false)
    remote.startRecharge.mockRejectedValueOnce(new Error('timeout'))
    render(<AccountPanel {...props} />)
    await waitFor(() => { expect(screen.getByText('fixture-17')).toBeTruthy() })
    await openAlipayTab()
    fireEvent.change(screen.getByLabelText(zh.rechargeAmount), { target: { value: '12.34' } })
    fireEvent.click(screen.getByRole('button', { name: zh.rechargePay }))
    await waitFor(() => { expect(remote.startRecharge).toHaveBeenCalledTimes(1) })
    fireEvent.click(screen.getByRole('button', { name: zh.alipayRecover }))
    await waitFor(() => { expect(remote.alipayOrders).toHaveBeenCalledTimes(1) })
    expect(remote.startRecharge).toHaveBeenCalledTimes(1)
  })

  it('keeps a 409 conflict locked and allows a separate account its own intent', async () => {
    const first = fixture()
    first.remote.startRecharge.mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(ok({ kind: 'conflict' as const }))
    const mounted = render(<AccountPanel {...first.props} />)
    await waitFor(() => { expect(screen.getByText('fixture-17')).toBeTruthy() })
    await openAlipayTab()
    fireEvent.change(screen.getByLabelText(zh.rechargeAmount), { target: { value: '12.34' } })
    fireEvent.click(screen.getByRole('button', { name: zh.rechargePay }))
    await waitFor(() => { expect(first.remote.startRecharge).toHaveBeenCalledTimes(1) })
    fireEvent.click(screen.getByRole('button', { name: zh.alipayRecover }))
    await waitFor(() => { expect(screen.getByText(zh.alipayConflict)).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh.alipayRecover }))
    await waitFor(() => { expect(first.remote.alipayOrders).toHaveBeenCalledTimes(1) })
    expect(first.remote.startRecharge).toHaveBeenCalledTimes(2)
    mounted.unmount()

    const other = fixture('18')
    render(<AccountPanel {...other.props} />)
    await waitFor(() => { expect(screen.getByText('fixture-18')).toBeTruthy() })
    await openAlipayTab()
    fireEvent.change(screen.getByLabelText(zh.rechargeAmount), { target: { value: '12.34' } })
    fireEvent.click(screen.getByRole('button', { name: zh.rechargePay }))
    await waitFor(() => { expect(other.remote.startRecharge).toHaveBeenCalledTimes(1) })
    expect(localStorage.getItem('qianshou.pc.alipay-recharge.17')).not.toBeNull()
    expect(localStorage.getItem('qianshou.pc.alipay-recharge.18')).not.toBeNull()
  })
})
