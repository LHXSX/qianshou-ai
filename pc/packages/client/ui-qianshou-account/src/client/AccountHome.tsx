/** Signed-in account home with separate plan and recharge actions. */
import { useEffect, useState } from 'react'
import { AccountExitConfirmation, type AccountExitIntent } from './AccountExitConfirmation.tsx'
import QRCode from 'qrcode/lib/browser.js'
import type { AccountSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { AccountController, AccountPaymentView, AccountRechargeOrderView,
  AccountWechatOrderView } from './controller.ts'
import type { AccountKey } from './locales.ts'
import css from './AccountPanel.module.css'
import payCss from './AccountHome.payment.module.css'

const ALIPAY_ACTION = 'https://openapi.alipay.com/gateway.do?charset=utf-8'

type Copy = (key: AccountKey, params?: Record<string, string>) => string
type Flow = 'overview' | 'plans' | 'recharge'
type Gateway = 'wechat_pay' | 'alipay'
interface WechatMarker {
  startedAt: number
  amount: string | null
  orderNo: string | null
  /** Generated before the first POST and retained across timeouts/restarts. */
  idempotencyKey: string | null
  conflict: boolean
}
const RECHARGE_KEY = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const BLOCKED_MARKER: WechatMarker = { startedAt: 0, amount: null, orderNo: null,
  idempotencyKey: null, conflict: false }

function markerKey(accountId: string): string { return `qianshou.pc.wechat-recharge.${accountId}` }
function alipayMarkerKey(accountId: string): string { return `qianshou.pc.alipay-recharge.${accountId}` }
function storedMarker(key: string): WechatMarker | null {
  const raw = localStorage.getItem(key)
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<WechatMarker>
    if (typeof value.startedAt === 'number' && Number.isFinite(value.startedAt)
      && (value.amount === null || typeof value.amount === 'string')
      && (value.orderNo === null || typeof value.orderNo === 'string')
      && (value.idempotencyKey === undefined || value.idempotencyKey === null
        || (typeof value.idempotencyKey === 'string' && RECHARGE_KEY.test(value.idempotencyKey)))) {
      return { startedAt: value.startedAt, amount: value.amount,
        orderNo: value.orderNo, idempotencyKey: value.idempotencyKey ?? null,
        conflict: value.conflict === true }
    }
  } catch { /* An unreadable marker still blocks another financial POST. */ }
  return BLOCKED_MARKER
}
function markerOf(accountId: string): WechatMarker | null { return storedMarker(markerKey(accountId)) }
function alipayMarkerOf(accountId: string): WechatMarker | null { return storedMarker(alipayMarkerKey(accountId)) }
function saveStoredMarker(key: string, marker: WechatMarker): void {
  const value = JSON.stringify(marker)
  localStorage.setItem(key, value)
  if (localStorage.getItem(key) !== value) throw new Error('marker-not-saved')
}
function saveMarker(accountId: string, marker: WechatMarker): void { saveStoredMarker(markerKey(accountId), marker) }
function saveAlipayMarker(accountId: string, marker: WechatMarker): void {
  saveStoredMarker(alipayMarkerKey(accountId), marker)
}
function clearStoredMarker(key: string): void {
  localStorage.removeItem(key)
  if (localStorage.getItem(key) !== null) throw new Error('marker-not-cleared')
}
function clearMarker(accountId: string): void { clearStoredMarker(markerKey(accountId)) }
function clearAlipayMarker(accountId: string): void { clearStoredMarker(alipayMarkerKey(accountId)) }
function normalizedAmount(value: string): string | null {
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/u.test(value.trim())) return null
  const [whole = '', decimal = ''] = value.trim().split('.')
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'))
  return cents >= 1 && cents <= 100_000_000 ? `${whole}.${decimal.padEnd(2, '0')}` : null
}

/** Submit only the reviewed server-signed Alipay form. */
function openAlipay(payment: AccountPaymentView): boolean {
  if (payment.action !== ALIPAY_ACTION) return false
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = payment.action
  form.acceptCharset = 'utf-8'
  form.target = '_blank'
  for (const field of payment.fields) {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = field.name
    input.value = field.value
    form.append(input)
  }
  document.body.append(form)
  form.submit()
  form.remove()
  return true
}

/** Props for the signed-in account home. */
export interface AccountHomeProps {
  controller: AccountController
  busy: boolean
  snapshot: AccountSnapshot
  t: Copy
}

/** Show server-backed account facts before the optional purchase flows. */
export function AccountHome({ controller, busy, snapshot, t }: AccountHomeProps) {
  const account = snapshot.account
  const { commerce, commerceBusy, commerceFailed, paymentBusy, paymentFailed, payment } = controller.store.getSnapshot()
  const [exitIntent, setExitIntent] = useState<AccountExitIntent | null>(null)
  useEffect(() => { setExitIntent(null) }, [account?.id])
  const [flow, setFlow] = useState<Flow>('overview')
  const [amount, setAmount] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [checkoutRequested, setCheckoutRequested] = useState(false)
  const [gateway, setGateway] = useState<Gateway>('wechat_pay')
  const [wechatMarker, setWechatMarker] = useState<WechatMarker | null>(null)
  const [alipayMarker, setAlipayMarker] = useState<WechatMarker | null>(null)
  const [alipayCandidates, setAlipayCandidates] = useState<readonly AccountRechargeOrderView[]>([])
  const [wechatStorageFailed, setWechatStorageFailed] = useState(false)
  const [wechatAmountFailed, setWechatAmountFailed] = useState(false)
  const [wechatCandidates, setWechatCandidates] = useState<readonly AccountWechatOrderView[]>([])
  const [wechatQr, setWechatQr] = useState('')
  const [wechatQrFailed, setWechatQrFailed] = useState(false)
  useEffect(() => { void controller.loadCommerce() }, [controller, account?.id])
  useEffect(() => {
    if (flow !== 'recharge' || !account?.id) return
    void controller.loadWechatChannel()
    try {
      const wechat = markerOf(account.id)
      const alipay = alipayMarkerOf(account.id)
      setWechatMarker(wechat)
      setAlipayMarker(alipay)
      if (alipay && !wechat) setGateway('alipay')
      setWechatStorageFailed(false)
    } catch {
      setWechatMarker(BLOCKED_MARKER)
      setAlipayMarker(BLOCKED_MARKER)
      setWechatStorageFailed(true)
    }
  }, [controller, flow, account?.id])
  const { wechatChannel, wechatRechargeIdempotency, wechatChannelBusy, wechatChannelFailed,
    wechatOrder, wechatBusy, wechatFailed, alipayOrder } = controller.store.getSnapshot()
  useEffect(() => {
    let active = true
    setWechatQr('')
    setWechatQrFailed(false)
    if (wechatOrder?.status === 'pending' && wechatOrder.providerState !== 'CLOSED' && wechatOrder.codeUrl) {
      void QRCode.toString(wechatOrder.codeUrl, { type: 'svg', width: 220, margin: 1 })
        .then(svg => { if (active) setWechatQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`) })
        .catch(() => { if (active) setWechatQrFailed(true) })
    }
    return () => { active = false }
  }, [wechatOrder?.orderNo, wechatOrder?.codeUrl, wechatOrder?.status, wechatOrder?.providerState])
  useEffect(() => {
    if (flow !== 'recharge' || gateway !== 'wechat_pay' || wechatOrder?.status !== 'pending'
      || wechatOrder.providerState === 'CLOSED') return
    const number = wechatOrder.orderNo
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden' && !controller.store.getSnapshot().wechatBusy) {
        void controller.loadWechatOrder(number)
      }
    }, 6000)
    return () => { window.clearInterval(timer) }
  }, [controller, flow, gateway, wechatOrder?.orderNo, wechatOrder?.status, wechatOrder?.providerState])
  useEffect(() => {
    if (!account?.id || !wechatOrder || !wechatMarker) return
    if (wechatMarker.orderNo !== wechatOrder.orderNo) return
    if (wechatOrder.status !== 'paid' && wechatOrder.providerState !== 'CLOSED') return
    try { clearMarker(account.id); setWechatMarker(null) }
    catch { setWechatStorageFailed(true) }
    if (wechatOrder.status === 'paid') void controller.loadCommerce()
  }, [controller, account?.id, wechatOrder?.orderNo, wechatOrder?.status,
    wechatOrder?.providerState, wechatMarker?.orderNo])
  useEffect(() => {
    if (!account?.id || !alipayOrder || !alipayMarker || alipayOrder.status !== 'paid'
      || alipayMarker.orderNo !== alipayOrder.orderNo) return
    try { clearAlipayMarker(account.id); setAlipayMarker(null) }
    catch { setWechatStorageFailed(true) }
    setCheckoutRequested(false)
    void controller.loadCommerce()
  }, [controller, account?.id, alipayOrder?.orderNo, alipayOrder?.status, alipayMarker?.orderNo])
  if (account === null) return null

  const sameAccount = () => controller.store.getSnapshot().snapshot?.account?.id === account.id

  const updateMarker = (value: WechatMarker | null) => {
    try {
      if (value === null) clearMarker(account.id)
      else saveMarker(account.id, value)
      setWechatMarker(value)
      setWechatStorageFailed(false)
      return true
    } catch {
      setWechatStorageFailed(true)
      return false
    }
  }
  const updateAlipayMarker = (value: WechatMarker | null) => {
    try {
      if (value === null) clearAlipayMarker(account.id)
      else saveAlipayMarker(account.id, value)
      setAlipayMarker(value)
      setWechatStorageFailed(false)
      return true
    } catch {
      setWechatStorageFailed(true)
      return false
    }
  }
  const createWechatOrder = async () => {
    if (wechatBusy || wechatChannel !== true || wechatMarker || wechatOrder || alipayMarker) return
    setWechatAmountFailed(false)
    const normalized = normalizedAmount(amount)
    if (normalized === null) { setWechatAmountFailed(true); return }
    if (!navigator.locks?.request) { setWechatStorageFailed(true); return }
    await navigator.locks.request(`qianshou-pc-recharge-${account.id}`, { mode: 'exclusive' }, async () => {
      let existing: WechatMarker | null
      try { existing = markerOf(account.id) }
      catch { setWechatStorageFailed(true); return }
      if (existing) { setWechatMarker(existing); return }
      try {
        const other = alipayMarkerOf(account.id)
        if (other) { setAlipayMarker(other); return }
      } catch { setWechatStorageFailed(true); return }
      let idempotencyKey: string
      try { idempotencyKey = crypto.randomUUID() }
      catch { setWechatStorageFailed(true); return }
      if (!RECHARGE_KEY.test(idempotencyKey)) { setWechatStorageFailed(true); return }
      const marker: WechatMarker = { startedAt: Date.now(), amount: normalized, orderNo: null,
        idempotencyKey, conflict: false }
      if (!updateMarker(marker)) return
      const result = await controller.startWechatRecharge(normalized, idempotencyKey)
      if (!sameAccount()) return
      if (result?.kind === 'ready') updateMarker({ ...marker, orderNo: result.order.orderNo })
      else if (result?.kind === 'unknown' && result.orderNo) updateMarker({ ...marker, orderNo: result.orderNo })
      else if (result?.kind === 'conflict') updateMarker({ ...marker, conflict: true })
      // Any unconfirmed outcome retains this key; a new intent is never inferred.
    })
  }
  const recoverWechatOrder = async (specific?: string) => {
    if (!wechatMarker) return
    if (!navigator.locks?.request) { setWechatStorageFailed(true); return }
    await navigator.locks.request(`qianshou-pc-recharge-${account.id}`, { mode: 'exclusive' }, async () => {
      if (!sameAccount()) return
      let marker: WechatMarker | null
      try { marker = markerOf(account.id) }
      catch { setWechatStorageFailed(true); return }
      if (!marker) return
      const number = specific ?? marker.orderNo
      if (number) {
        const recovered = await controller.loadWechatOrder(number)
        if (!sameAccount()) return
        if (recovered && !marker.orderNo) updateMarker({ ...marker, orderNo: recovered.orderNo })
        return
      }
      if (marker.idempotencyKey && marker.amount && wechatRechargeIdempotency && !marker.conflict) {
        const result = await controller.startWechatRecharge(marker.amount, marker.idempotencyKey, true)
        if (!sameAccount()) return
        if (result?.kind === 'ready') { updateMarker({ ...marker, orderNo: result.order.orderNo }); return }
        if (result?.kind === 'unknown' && result.orderNo) {
          updateMarker({ ...marker, orderNo: result.orderNo }); return
        }
        if (result?.kind === 'conflict') { updateMarker({ ...marker, conflict: true }); return }
      }
      const history = await controller.listWechatOrders()
      if (!sameAccount()) return
      if (!history) return
      const sameAmount = history.filter(order => order.amount === marker.amount)
      const matches = sameAmount.filter(order => order.createdAt >= marker.startedAt - 5000)
      setWechatCandidates(sameAmount.slice(0, 10))
      if (matches.length === 1 && matches[0]) {
        updateMarker({ ...marker, orderNo: matches[0].orderNo })
        await controller.loadWechatOrder(matches[0].orderNo)
      }
    })
  }

  const createAlipayOrder = async () => {
    if (paymentBusy || alipayMarker || alipayOrder || wechatMarker || wechatOrder?.status === 'pending') return
    const normalized = normalizedAmount(amount)
    if (normalized === null) { setWechatAmountFailed(true); return }
    if (!navigator.locks?.request) { setWechatStorageFailed(true); return }
    await navigator.locks.request(`qianshou-pc-recharge-${account.id}`, { mode: 'exclusive' }, async () => {
      try {
        const existing = alipayMarkerOf(account.id)
        const other = markerOf(account.id)
        if (existing) { setAlipayMarker(existing); return }
        if (other) { setWechatMarker(other); setGateway('wechat_pay'); return }
      } catch { setWechatStorageFailed(true); return }
      let idempotencyKey: string
      try { idempotencyKey = crypto.randomUUID() }
      catch { setWechatStorageFailed(true); return }
      if (!RECHARGE_KEY.test(idempotencyKey)) { setWechatStorageFailed(true); return }
      const marker: WechatMarker = { startedAt: Date.now(), amount: normalized, orderNo: null,
        idempotencyKey, conflict: false }
      if (!updateAlipayMarker(marker)) return
      setCheckoutRequested(false)
      const result = await controller.startRecharge(normalized, idempotencyKey)
      if (!sameAccount()) return
      if (result?.kind === 'ready') {
        updateAlipayMarker({ ...marker, orderNo: result.order.orderNo })
        setCheckoutRequested(openAlipay(result.payment))
      } else if (result?.kind === 'order') updateAlipayMarker({ ...marker, orderNo: result.order.orderNo })
      else if (result?.kind === 'unknown' && result.orderNo) updateAlipayMarker({ ...marker, orderNo: result.orderNo })
      else if (result?.kind === 'conflict') updateAlipayMarker({ ...marker, conflict: true })
    })
  }

  const recoverAlipayOrder = async (specific?: string) => {
    if (!alipayMarker) return
    if (!navigator.locks?.request) { setWechatStorageFailed(true); return }
    await navigator.locks.request(`qianshou-pc-recharge-${account.id}`, { mode: 'exclusive' }, async () => {
      if (!sameAccount()) return
      let marker: WechatMarker | null
      try { marker = alipayMarkerOf(account.id) }
      catch { setWechatStorageFailed(true); return }
      if (!marker) return
      const number = specific ?? marker.orderNo
      if (number) {
        const recovered = await controller.loadAlipayOrder(number)
        if (!sameAccount()) return
        if (recovered && !marker.orderNo) updateAlipayMarker({ ...marker, orderNo: recovered.orderNo })
        return
      }
      if (marker.idempotencyKey && marker.amount && wechatRechargeIdempotency && !marker.conflict) {
        const result = await controller.startRecharge(marker.amount, marker.idempotencyKey, true)
        if (!sameAccount()) return
        if (result?.kind === 'ready') {
          updateAlipayMarker({ ...marker, orderNo: result.order.orderNo })
          setCheckoutRequested(openAlipay(result.payment))
          return
        }
        if (result?.kind === 'order') { updateAlipayMarker({ ...marker, orderNo: result.order.orderNo }); return }
        if (result?.kind === 'unknown' && result.orderNo) {
          updateAlipayMarker({ ...marker, orderNo: result.orderNo }); return
        }
        if (result?.kind === 'conflict') { updateAlipayMarker({ ...marker, conflict: true }); return }
      }
      const history = await controller.listAlipayOrders()
      if (!sameAccount()) return
      if (!history) return
      const sameAmount = history.filter(order => order.amount === marker.amount)
      const matches = sameAmount.filter(order => order.createdAt >= marker.startedAt - 5000)
      setAlipayCandidates(sameAmount.slice(0, 10))
      if (matches.length === 1 && matches[0]) {
        updateAlipayMarker({ ...marker, orderNo: matches[0].orderNo })
        await controller.loadAlipayOrder(matches[0].orderNo)
      }
    })
  }

  const pending = busy || commerceBusy || paymentBusy
  const planKnown = commerce !== null && !commerceFailed
  const remaining = planKnown && commerce.remainingSp !== null ? t('remaining', { amount: String(commerce.remainingSp) }) : t('unread')
  const balance = planKnown && commerce.balanceYuan !== null ? t('wallet', { amount: commerce.balanceYuan }) : t('unread')
  const windowKnown = planKnown && commerce.windowLimitSp !== null && commerce.usedInWindowSp !== null
  const windowPercent = windowKnown && commerce.windowLimitSp !== null && commerce.usedInWindowSp !== null
    ? commerce.windowLimitSp === 0 ? 0 : Math.min(100, Math.round(commerce.usedInWindowSp / commerce.windowLimitSp * 100)) : 0

  return <div className={css.home}>
    <header className={css.identity}>
      <span className={css.avatar} aria-hidden="true">{account.username.slice(0, 1).toLocaleUpperCase()}</span>
      <div className={css.identityText}>
        <strong>{account.username}</strong>
        <span className={css.verified}>{t(snapshot.phase)}</span>
      </div>
    </header>

    <div className={css.summaryGrid}>
      <section className={css.summaryCard} aria-label={t('planTitle')}>
        <span className={css.summaryLabel}>{t('planTitle')}</span>
        <strong className={css.summaryValue}>{planKnown ? commerce.tierLabel || t('unread') : t('unread')}</strong>
        <span className={css.summaryMeta}>{t('accountAvailableSp')}: {remaining}</span>
      </section>
      <section className={css.summaryCard} aria-label={t('walletTitle')}>
        <span className={css.summaryLabel}>{t('walletTitle')}</span>
        <strong className={css.summaryValue}>{balance}</strong>
        <span className={css.summaryMeta}>{t('walletSource')}</span>
      </section>

      <section className={css.windowCard} aria-label={t('windowTitle')}>
        <div className={css.windowHead}>
          <strong>{t('windowTitle')}</strong>
          <span>{windowKnown && commerce !== null && commerce.usedInWindowSp !== null && commerce.windowLimitSp !== null
            ? t('windowUsage', { used: String(commerce.usedInWindowSp), limit: String(commerce.windowLimitSp) }) : t('unread')}</span>
        </div>
        {windowKnown && commerce !== null && commerce.windowLimitSp !== null && commerce.usedInWindowSp !== null
          ? <div className={css.meter} role="progressbar" aria-valuemin={0} aria-valuemax={commerce.windowLimitSp}
            aria-valuenow={commerce.usedInWindowSp}
            aria-label={t('windowUsage', { used: String(commerce.usedInWindowSp), limit: String(commerce.windowLimitSp) })}>
            <span className={css.meterFill} style={{ width: `${windowPercent}%` }} />
          </div> : null}
        <p className={css.hint}>{t('windowNote')}</p>
      </section>

      <section className={css.incomeCard} aria-label={t('incomeTitle')}>
        <div className={css.incomeText}>
          <span className={css.summaryLabel}>{t('incomeTitle')}</span>
          <strong>{t('incomeValue')}</strong>
          <span className={css.summaryMeta}>{t('incomeSource')}</span>
        </div>
        <button type="button" onClick={() => { window.dispatchEvent(new Event('qianshou:open-intake')) }}>
          {t('incomeOpen')} <span aria-hidden="true">→</span>
        </button>
      </section>
    </div>

    {commerceFailed && <div className={css.inlineAlert} role="alert">
      <span>{t('commerceUnavailable')}</span>
      <button type="button" disabled={pending} onClick={() => { void controller.loadCommerce() }}>{t('retry')}</button>
    </div>}

    {flow === 'overview' && <div className={css.primaryActions}>
      <button type="button" className={css.primaryAction} onClick={() => { setFlow('plans') }}>
        <span><strong>{t('managePlan')}</strong><small>{t('managePlanHint')}</small></span><span aria-hidden="true">→</span>
      </button>
      <button type="button" className={css.primaryAction} onClick={() => { setFlow('recharge') }}>
        <span><strong>{t('rechargeTitle')}</strong><small>{t('rechargeHint')}</small></span><span aria-hidden="true">→</span>
      </button>
    </div>}

    {flow === 'plans' && <section className={css.flowSection} aria-label={t('subscribe')}>
      <button type="button" className={css.back} onClick={() => { setFlow('overview'); setSelected(null) }}>{t('backToAccount')}</button>
      <h3>{t('subscribe')}</h3>
      <p className={css.hint}>{t('planChooseHint')}</p>
      {commerceBusy && <p role="status">{t('busy')}</p>}
      {!commerceBusy && (commerce === null || commerce.plans.length === 0)
        ? <p role="status" className={css.hint}>{t('plansEmpty')}</p>
        : <div className={css.planList}>{commerce?.plans.map(plan => (
          <button key={plan.id} type="button" disabled={pending || commerceFailed} aria-pressed={selected === plan.id}
            className={selected === plan.id ? css.planSelected : css.planOption}
            onClick={() => { setSelected(plan.id); void controller.quotePlan(plan.id) }}>
            <strong>{plan.label}</strong>
            <span>{plan.monthlyYuan === null ? t('priceUnread') : t('planMonthlyPrice', { amount: String(plan.monthlyYuan) })}</span>
          </button>
        ))}</div>}
      {commerce?.quote && !commerceFailed && <div className={css.quote}>
        <div className={css.quoteLine}><span>{t('selectedPlan')}</span><strong>{commerce.quote.label}</strong></div>
        <div className={css.quoteLine}><span>{t('quoteSp', { amount: String(commerce.quote.monthlySp) })}</span><strong>{t('payAmount', { amount: commerce.quote.amountYuan })}</strong></div>
        <button type="button" className={css.pay} disabled={pending || !commerce.quote.canPay}
          onClick={() => { void controller.buyPlan() }}>{t('confirmPlan')}</button>
        {!commerce.quote.canPay && <p className={css.hint}>{t('insufficient-balance')}</p>}
      </div>}
      {commerce?.notice === 'paid' && <p role="status" className={css.success}>{t('paid')}</p>}
      {commerce?.notice === 'quote-expired' && <p role="alert">{t('quote-expired')}</p>}
      {commerce?.notice === 'downgrade-not-allowed' && <p role="status">{t('downgrade-not-allowed')}</p>}
      {commerce?.notice === 'insufficient-balance' && <p role="alert">{t('insufficient-balance')}</p>}
      {commerce?.notice === 'unavailable' && <p role="alert">{t('commerceUnavailable')}</p>}
    </section>}

    {flow === 'recharge' && <section className={css.flowSection} aria-label={t('rechargeTitle')}>
      <button type="button" className={css.back} onClick={() => { setFlow('overview'); setCheckoutRequested(false) }}>{t('backToAccount')}</button>
      <h3>{t('rechargeTitle')}</h3>
      <p className={css.hint}>{t('rechargeIntro')}</p>
      <div className={payCss.methodGroup} role="group" aria-label={t('rechargeMethod')}>
        <button type="button" className={gateway === 'wechat_pay' ? payCss.methodActive : payCss.method}
          aria-pressed={gateway === 'wechat_pay'} disabled={alipayMarker !== null}
          onClick={() => { setGateway('wechat_pay') }}>{t('wechatPay')}</button>
        <button type="button" className={gateway === 'alipay' ? payCss.methodActive : payCss.method}
          aria-pressed={gateway === 'alipay'} disabled={wechatMarker !== null || wechatOrder?.status === 'pending'}
          onClick={() => { setGateway('alipay') }}>{t('alipayPay')}</button>
      </div>
      {gateway === 'wechat_pay' && <div className={payCss.checkout}>
        <div className={payCss.channelRow}>
          <strong>{t('wechatPay')}</strong>
          <span className={wechatChannel === true ? payCss.ready : payCss.unavailable}>
            {wechatChannelBusy ? t('wechatChannelChecking') : wechatChannel === true ? t('wechatPay') : t('wechatChannelUnavailable')}
          </span>
        </div>
        {(wechatChannelFailed || wechatChannel === false) && <div className={payCss.notice} role="status">
          {t('wechatChannelUnavailable')} <button type="button" disabled={wechatChannelBusy}
            onClick={() => { void controller.loadWechatChannel() }}>{t('retry')}</button>
        </div>}
        <form className={css.form} onSubmit={event => { event.preventDefault(); void createWechatOrder() }}>
          <label>{t('rechargeAmount')}<input aria-label={t('rechargeAmount')} inputMode="decimal" value={amount}
            disabled={pending || wechatBusy || wechatMarker !== null || wechatOrder !== null || alipayMarker !== null}
            onChange={event => { setAmount(event.target.value); setWechatAmountFailed(false) }} /></label>
          <button type="submit" className={css.pay} disabled={pending || wechatBusy || wechatChannel !== true
            || amount.trim() === '' || wechatMarker !== null || wechatOrder !== null || alipayMarker !== null}>
            {wechatBusy ? t('wechatLoading') : t('wechatCreate')}
          </button>
        </form>
        {wechatAmountFailed && <p role="alert" className={css.inlineAlert}>{t('wechatAmountInvalid')}</p>}
        {wechatStorageFailed && <p role="alert" className={css.inlineAlert}>{t('wechatStorageUnavailable')}</p>}
        {wechatFailed && <p role="alert" className={css.inlineAlert}>{t('wechatUnavailable')}</p>}
        {wechatMarker && (!wechatOrder || wechatOrder.orderNo !== wechatMarker.orderNo) && <div className={payCss.recovery} role="alert">
          <strong>{t(wechatMarker.conflict ? 'wechatConflict' : 'wechatUnknown')}</strong>
          <button type="button" disabled={wechatBusy} onClick={() => { void recoverWechatOrder() }}>
            {wechatBusy ? t('wechatLoading') : t('wechatRecover')}
          </button>
          {wechatCandidates.map(candidate => <button key={candidate.orderNo} type="button" disabled={wechatBusy}
            onClick={() => { void recoverWechatOrder(candidate.orderNo) }}>
            {t('wechatOrder', { order: candidate.orderNo, amount: candidate.amount })}
          </button>)}
        </div>}
        {wechatOrder && <div className={payCss.order} aria-label={t('wechatOrder', { order: wechatOrder.orderNo, amount: wechatOrder.amount })}>
          <div className={payCss.orderHead}>
            <strong>{t('wechatOrder', { order: wechatOrder.orderNo, amount: wechatOrder.amount })}</strong>
            <span>{wechatOrder.status === 'paid' ? t('wechatPaid')
              : wechatOrder.providerState === 'CLOSED' ? t('wechatConfirmedClosed')
                : wechatOrder.status === 'pending' ? t('wechatPending') : t('wechatUnsettled')}</span>
          </div>
          {wechatOrder.status === 'pending' && wechatOrder.providerState !== 'CLOSED' && <div className={payCss.scanArea}>
            {wechatQr && <img src={wechatQr} width="220" height="220" alt={t('wechatScan')} />}
            <div className={payCss.scanDetails}>
              <strong>{wechatQr ? t('wechatScan') : t('wechatRetryQr')}</strong>
              <p>{t('wechatCrossDevice')}</p>
              <p>{t('wechatPending')}</p>
              {wechatQrFailed && <p role="alert">{t('wechatQrError')}</p>}
              {!wechatQr && <button type="button" disabled={wechatBusy}
                onClick={() => { void controller.retryWechatOrderPayment(wechatOrder.orderNo) }}>{t('wechatRetryQr')}</button>}
            </div>
          </div>}
          {wechatOrder.status === 'paid' && <p role="status" className={payCss.paid}>{t('wechatPaid')}</p>}
          {(wechatOrder.status === 'paid' || wechatOrder.providerState === 'CLOSED') && wechatMarker === null
            && <button type="button" className={payCss.secondary}
              onClick={() => { controller.clearWechatOrder(); setWechatCandidates([]) }}>{t('wechatNewOrder')}</button>}
          {(wechatOrder.status === 'pending' || wechatOrder.status === 'expired')
            && wechatOrder.providerState !== 'CLOSED' && <button type="button" className={payCss.secondary}
            disabled={wechatBusy} onClick={() => { void controller.refreshWechatOrder(wechatOrder.orderNo) }}>
            {wechatBusy ? t('wechatLoading') : t('wechatVerify')}
          </button>}
        </div>}
      </div>}
      {gateway === 'alipay' && <div className={payCss.checkout}>
        <form className={css.form} onSubmit={(event) => { event.preventDefault(); void createAlipayOrder() }}>
          <label>{t('rechargeAmount')}<input aria-label={t('rechargeAmount')} inputMode="decimal" value={amount}
            disabled={pending || alipayMarker !== null || alipayOrder !== null}
            onChange={(event) => { setAmount(event.target.value); setWechatAmountFailed(false) }} /></label>
          <button type="submit" className={css.pay} disabled={pending || amount.trim() === ''
            || alipayMarker !== null || alipayOrder !== null}>{t('rechargePay')}</button>
        </form>
        {wechatAmountFailed && <p role="alert" className={css.inlineAlert}>{t('wechatAmountInvalid')}</p>}
        {wechatStorageFailed && <p role="alert" className={css.inlineAlert}>{t('wechatStorageUnavailable')}</p>}
        {alipayMarker && (!alipayOrder || alipayOrder.orderNo !== alipayMarker.orderNo)
          && <div className={payCss.recovery} role="alert">
            <strong>{t(alipayMarker.conflict ? 'alipayConflict' : 'alipayUnknown')}</strong>
            <button type="button" disabled={paymentBusy} onClick={() => { void recoverAlipayOrder() }}>
              {paymentBusy ? t('wechatLoading') : t('alipayRecover')}
            </button>
            {alipayCandidates.map(candidate => <button key={candidate.orderNo} type="button" disabled={paymentBusy}
              onClick={() => { void recoverAlipayOrder(candidate.orderNo) }}>
              {t('wechatOrder', { order: candidate.orderNo, amount: candidate.amount })}
            </button>)}
          </div>}
        {alipayOrder && <div className={payCss.order} aria-label={t('wechatOrder', {
          order: alipayOrder.orderNo, amount: alipayOrder.amount })}>
          <div className={payCss.orderHead}>
            <strong>{t('wechatOrder', { order: alipayOrder.orderNo, amount: alipayOrder.amount })}</strong>
            <span>{alipayOrder.status === 'paid' ? t('alipayPaid')
              : alipayOrder.status === 'pending' ? t('alipayPending') : t('alipayUnsettled')}</span>
          </div>
          {alipayOrder.status === 'pending' && <button type="button" className={payCss.secondary}
            disabled={paymentBusy} onClick={() => {
              void controller.retryAlipayOrderPayment(alipayOrder.orderNo, alipayOrder.amount)
                .then(fields => { if (fields) setCheckoutRequested(openAlipay(fields)) })
            }}>{t('alipayReopen')}</button>}
          {alipayOrder.status !== 'paid' && <button type="button" className={payCss.secondary}
            disabled={paymentBusy} onClick={() => { void controller.loadAlipayOrder(alipayOrder.orderNo) }}>
            {t('alipayCheck')}
          </button>}
          {alipayOrder.status === 'paid' && alipayMarker === null && <button type="button"
            className={payCss.secondary} onClick={() => {
              controller.clearAlipayOrder(); setAlipayCandidates([]); setCheckoutRequested(false)
            }}>{t('wechatNewOrder')}</button>}
        </div>}
      </div>}
      {gateway === 'alipay' && paymentFailed && <p role="alert" className={css.inlineAlert}>{t('rechargeUnavailable')}</p>}
      {gateway === 'alipay' && checkoutRequested && payment !== null && <p role="status" className={css.hint}>{t('rechargeRequested')}</p>}
    </section>}

    <section className={css.accountManagement} aria-label={t('accountManagement')}>
      <div><h3>{t('accountManagement')}</h3><p className={css.hint}>{t('accountManagementHint')}</p></div>
      <div className={css.accountManagementActions}>
        <button type="button" disabled={busy} onClick={() => { setExitIntent({ ownerId: account.id, kind: 'switch' }) }}>
          {t('switchAccount')}
        </button>
        <button type="button" disabled={busy} onClick={() => { setExitIntent({ ownerId: account.id, kind: 'logout' }) }}>
          {t('logout')}
        </button>
      </div>
    </section>
    <AccountExitConfirmation controller={controller} intent={exitIntent} busy={busy}
      failed={controller.store.getSnapshot().failed} t={t} onClose={() => { setExitIntent(null) }} />

    <div className={css.secondaryActions}>
      <button type="button" disabled={busy} onClick={() => { void controller.reconnect() }}>{t('reconnect')}</button>
      <button type="button" disabled={busy} onClick={() => { void controller.useCloud() }}>{t('useCloud')}</button>
    </div>
    {snapshot.cloudSelected && <p className={css.success} role="status">{t('selected')}</p>}
  </div>
}
