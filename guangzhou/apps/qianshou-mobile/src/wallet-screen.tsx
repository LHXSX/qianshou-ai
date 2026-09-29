import { useCallback, useEffect, useState } from 'react'
import { renderSVG } from 'uqr'
import type { AccountService } from './account.ts'
import { amountOf, channelAvailable, createOrder, listOrders, readOrder, refreshPaymentCode, type WechatOrder } from './wechat-payment.ts'
import * as I from './icons.tsx'

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '暂时无法连接支付服务，请稍后重试。'
}

/** Native 合同只支持另一台设备扫码；同机微信支付需要另建 H5/JSAPI/App 合同。 */
export function WalletScreen({ service, onBack }: { service: AccountService; onBack: () => void }) {
  const account = service.snapshot().account
  const accountId = account === null ? null : String(account.id)
  const markerKey = accountId === null ? null : `qianshou.mobile.wechat-order.${accountId}`
  const [available, setAvailable] = useState<boolean | null>(null)
  const [amount, setAmount] = useState('10.00')
  const [order, setOrder] = useState<WechatOrder | null>(null)
  const [marker, setMarker] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checkedEmpty, setCheckedEmpty] = useState(false)

  const saveMarker = useCallback((value: string | null): boolean => {
    if (markerKey === null) return false
    try {
      if (value === null) localStorage.removeItem(markerKey)
      else localStorage.setItem(markerKey, value)
      setMarker(value)
      return true
    } catch { setError('本机存储不可用，暂不能安全创建订单。'); return false }
  }, [markerKey])

  useEffect(() => {
    let cancelled = false
    if (accountId === null || markerKey === null) return
    void channelAvailable(service).then(value => { if (!cancelled) setAvailable(value) })
      .catch(thrown => { if (!cancelled) { setAvailable(false); setError(messageOf(thrown)) } })
    try {
      const saved = localStorage.getItem(markerKey)
      if (saved !== null) setMarker(saved)
    } catch { if (!cancelled) setError('本机存储不可用，暂不能安全创建订单。') }
    return () => { cancelled = true }
  }, [accountId, markerKey, service])

  const checkOrder = useCallback(async (number: string): Promise<WechatOrder | null> => {
    if (accountId === null) return null
    const latest = await readOrder(service, accountId, number)
    if (latest.status === 'paid') {
      setOrder(latest)
      saveMarker(null)
      setNotice('上海订单已确认支付成功。')
      void service.loadAccount()
      return latest
    }
    if (latest.status !== 'pending') {
      setOrder(latest)
      saveMarker(null)
      setNotice('这笔订单已结束，可以重新下单。')
      return latest
    }
    setOrder(previous => previous?.orderNo === number && previous.codeUrl !== null
      ? { ...latest, codeUrl: previous.codeUrl } : latest)
    return latest
  }, [accountId, saveMarker, service])

  useEffect(() => {
    if (marker === null || marker === 'creating' || order?.status !== 'pending') return
    const timer = window.setInterval(() => { void checkOrder(marker).catch(() => {}) }, 5000)
    return () => window.clearInterval(timer)
  }, [checkOrder, marker, order?.status])

  async function recover(): Promise<void> {
    if (busy || accountId === null || marker === null) return
    setBusy(true); setError(null); setNotice(null)
    try {
      if (marker !== 'creating') {
        const current = await checkOrder(marker)
        if (current?.status === 'pending' && order?.codeUrl == null) {
          const restored = await refreshPaymentCode(service, accountId, marker)
          setOrder(restored)
        }
      } else {
        const records = await listOrders(service, accountId)
        const pending = records.find(item => item.status === 'pending')
        if (pending === undefined) {
          setCheckedEmpty(true)
          setNotice('订单记录中没有待支付微信订单。请核对账单，再决定是否重新下单。')
          return
        }
        saveMarker(pending.orderNo)
        const restored = await refreshPaymentCode(service, accountId, pending.orderNo)
        setOrder(restored)
      }
    } catch (thrown) { setError(messageOf(thrown)) }
    finally { setBusy(false) }
  }

  async function start(): Promise<void> {
    if (busy || available !== true || accountId === null || marker !== null) return
    if (amountOf(amount) === null) { setError('请填写有效充值金额，最多两位小数。'); return }
    if (!saveMarker('creating')) return // 写入“创建结果待核对”后才允许发 POST，避免未知结果再创建。
    setBusy(true); setError(null); setNotice(null); setCheckedEmpty(false)
    try {
      const created = await createOrder(service, accountId, amount)
      saveMarker(created.orderNo)
      setOrder(created)
    } catch (thrown) {
      setError(`${messageOf(thrown)}。创建结果未确认，请先核对订单记录，勿重复付款。`)
    } finally { setBusy(false) }
  }

  let qr: string | null = null
  if (order?.status === 'pending' && order.codeUrl !== null) {
    try { qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(order.codeUrl, { border: 2 }))}` }
    catch { qr = null }
  }

  return <div className="app">
    <div className="head"><button className="icon-btn" aria-label="返回" onClick={onBack}><I.IcoBack /></button><span className="brand-title">钱包与充值</span></div>
    <div className="scroll tight wallet-scroll">
      <section className="wallet-balance"><span>账户余额</span><strong>{account?.balance === null || account?.balance === undefined ? '—' : `¥ ${account.balance}`}</strong><small>余额以账号服务返回为准</small></section>
      <section className="wallet-card">
        <div className="wallet-heading"><span className="wallet-symbol">微</span><div><h2>微信扫码充值</h2><p>需用另一台设备打开微信扫描下方付款码</p></div></div>
        <p className="wallet-explain">当前仅支持微信 Native 扫码。手机上直接打开微信付款尚未接入；通道可用后才允许创建订单。</p>
        {available === null && <p className="wallet-status">正在查询支付通道…</p>}
        {available === false && <p className="wallet-status">微信扫码通道暂不可用，暂不能创建订单。</p>}
        {notice !== null && <p className="auth-notice" role="status">{notice}</p>}
        {error !== null && <p className="auth-error" role="alert">{error}</p>}
        {order?.status === 'pending' && <div className="wallet-order">
          <span>待支付订单 · {order.orderNo}</span><b>¥ {order.amount}</b>
          {qr !== null && <img className="wallet-qr" src={qr} alt="微信付款二维码，请使用另一台设备扫码" />}
          <small>另一台设备扫码后，等待上海订单确认。不要仅凭微信页面判断到账。</small>
          <button onClick={() => void checkOrder(order.orderNo).catch(thrown => setError(messageOf(thrown)))}>查询支付状态</button>
        </div>}
        {order?.status === 'paid' && <p className="wallet-success">这笔订单已由上海确认支付成功。</p>}
        {marker !== null && <div className="wallet-recover">
          <p>上次订单状态待核对，新订单已暂停。</p>
          <button disabled={busy} onClick={() => void recover()}>{busy ? '核对中…' : '核对原订单'}</button>
          {checkedEmpty && <button disabled={busy} onClick={() => { saveMarker(null); setCheckedEmpty(false); setNotice('请再次确认金额后再创建新订单。') }}>我已核对账单，重新下单</button>}
        </div>}
        {marker === null && <div className="wallet-pay-form">
          <label className="field"><span className="field-label">充值金额（元）</span><input value={amount} inputMode="decimal" onChange={event => setAmount(event.target.value)} /></label>
          <button className="primary auth-submit" disabled={busy || available !== true || amountOf(amount) === null || accountId === null} onClick={() => void start()}>
            {busy ? '创建订单中…' : '创建微信扫码订单'}
          </button>
        </div>}
      </section>
    </div>
  </div>
}
