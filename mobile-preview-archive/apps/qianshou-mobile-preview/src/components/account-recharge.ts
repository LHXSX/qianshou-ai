/** Compact CNY wallet recharge UI; every financial action needs a fresh explicit click. */
import { accountCopy as a, rechargeCopy as t } from './account-copy.ts'
import { createAlipayForm, rechargeAmount, RechargeFailure, type RechargeClient, type RechargeGateway, type RechargeInstructions } from './account-recharge-client.ts'
import { renderQrSvg } from '../../../../packages/client/ui-devices/src/client/phone-pairing-qr.ts'

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag); el.className = className; el.textContent = text; return el
}
/**
 * @param options One account page lifetime and its account-owned recharge client.
 * @returns Nothing; polling stops on hide, page disposal, account change, expiry, or ten minutes.
 */
export function renderAccountRecharge(options: {
  readonly container: HTMLElement
  readonly client?: RechargeClient
  readonly signal: AbortSignal
  readonly current: () => boolean
  readonly navigate: (page: 'commerce' | 'orders') => void
}): void {
  const { container, client, signal } = options
  container.dataset.testid = 'account-recharge'
  const section = node('section', 'account-recharge-panel')
  section.append(node('p', 'account-ledger-note', t.separate))
  container.append(section)
  if (!client) { section.append(node('p', 'account-muted', t.unavailable)); return }
  const owner = client.accountId()
  const alive = (): boolean => !signal.aborted && options.current() && client.accountId() === owner
  const balance = node('strong', '', a.unknown)
  const wallet = node('div', 'recharge-wallet'); wallet.append(node('span', '', t.balance), balance)
  const form = node('form', 'recharge-entry')
  const label = node('label', '', t.amount)
  const amount = node('input'); amount.type = 'text'; amount.inputMode = 'decimal'; amount.placeholder = t.amountHint
  amount.maxLength = 10; amount.autocomplete = 'off'; amount.setAttribute('aria-label', t.amount)
  label.append(amount)
  const channel = node('div', 'recharge-channel')
  const choices: Record<RechargeGateway, HTMLButtonElement> = {
    alipay: node('button', 'recharge-channel-choice', a.alipay),
    wechat_pay: node('button', 'recharge-channel-choice', t.wechat),
  }
  for (const choice of Object.values(choices)) { choice.type = 'button'; choice.disabled = true; channel.append(choice) }
  const availability = node('p', 'account-muted', t.loading)
  const primary = node('button', 'account-primary', t.create); primary.type = 'submit'; primary.disabled = true
  form.append(label, channel, availability, primary)
  const orderPanel = node('section', 'recharge-order')
  const notice = node('p', 'recharge-notice', t.loading); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite')
  const links = node('div', 'recharge-links')
  const action = (label: string, run: () => void, className = 'account-secondary'): HTMLButtonElement => {
    const button = node('button', className, label); button.type = 'button'
    button.addEventListener('click', () => { if (alive()) run() }, { signal }); return button
  }
  links.append(action(t.orders, () => { options.navigate('orders') }), action(t.backSubscription, () => { options.navigate('commerce') }))
  section.append(wallet, form, orderPanel, notice, links)
  let channels: Record<RechargeGateway, { available: boolean; reason: string | null }> = {
    alipay: { available: false, reason: null }, wechat_pay: { available: false, reason: null },
  }
  let gateway: RechargeGateway = 'alipay', busy = false, confirming = false
  let payment: RechargeInstructions | undefined
  let poll: ReturnType<typeof setTimeout> | undefined
  let pollAbort: AbortController | undefined
  const pollingDeadline = Date.now() + 10 * 60_000
  const stopPolling = (): void => { clearTimeout(poll); poll = undefined; pollAbort?.abort(); pollAbort = undefined }
  signal.addEventListener('abort', stopPolling, { once: true })
  const fail = (error: unknown): void => {
    if (!alive()) return
    notice.textContent = client.snapshot().unknown || error instanceof RechargeFailure && error.code === 'unknown' ? t.unknown : t.failed
  }
  const paint = (): void => {
    if (!alive()) return
    const state = client.snapshot()
    if (state.order?.status === 'pending') gateway = state.order.gateway
    amount.disabled = state.locked || busy
    primary.disabled = !channels[gateway].available || state.locked || busy
    primary.textContent = confirming ? t.confirm : t.create
    for (const [name, choice] of Object.entries(choices) as [RechargeGateway, HTMLButtonElement][]) {
      choice.disabled = state.locked || busy || !channels[name].available
      choice.setAttribute('aria-pressed', String(gateway === name))
    }
    availability.textContent = channels[gateway].available ? t.note : channels[gateway].reason ?? t.unavailable
    orderPanel.replaceChildren()
    const order = state.order
    if (state.unknown) { notice.textContent = t.unknown; payment = undefined }
    if (!order) return
    const heading = node('div', 'recharge-order-heading')
    heading.append(node('strong', '', `¥${order.amount}`), node('span', 'account-badge', order.status === 'paid' ? t.paid : order.status === 'pending' ? t.pending : t.ended))
    orderPanel.append(node('h3', '', t.order), heading, node('code', '', order.orderNo))
    if (order.status === 'paid') { notice.textContent = t.paid; payment = undefined; stopPolling(); return }
    if (order.status !== 'pending') { payment = undefined; stopPolling(); return }
    const expired = order.expiresAt === null || order.expiresAt <= Date.now()
    if (expired) { notice.textContent = t.expired; payment = undefined; stopPolling() }
    if (payment?.kind === 'alipay-page' && !expired) orderPanel.append(action(t.payment, () => {
      if (!payment || payment.kind !== 'alipay-page' || busy) return
      try {
        const currentOrder = client.snapshot().order
        if (!currentOrder || currentOrder.orderNo !== order.orderNo) throw new RechargeFailure('invalid')
        const post = createAlipayForm(payment, currentOrder)
        post.hidden = true; container.append(post)
        try { HTMLFormElement.prototype.submit.call(post) } finally { post.remove() }
        notice.textContent = t.paymentOpened
      } catch (error) { fail(error) }
    }, 'account-primary'))
    else if (payment?.kind === 'wechat-native' && !expired) {
      const qr = node('div', 'recharge-wechat-qr')
      qr.innerHTML = renderQrSvg(payment.codeUrl, { modulePx: 4, quietZone: 4, label: t.wechat })
      orderPanel.append(qr, node('p', 'account-muted', t.wechatOtherDevice), node('p', 'account-muted', t.wechatScanHelp))
    }
    else if (!expired) {
      const retry = action(t.retryPayment, () => { void run(async () => { payment = await client.payment(signal) }) })
      retry.disabled = busy; orderPanel.append(retry)
    }
    if (order.gateway === 'alipay') orderPanel.append(node('p', 'account-muted', t.pendingHelp))
  }
  const schedule = (): void => {
    stopPolling()
    if (!alive() || document.hidden) return
    const order = client.snapshot().order
    if (!order || order.status !== 'pending' || order.expiresAt === null || order.expiresAt <= Date.now()) return
    if (Date.now() >= pollingDeadline) { notice.textContent = t.paused; return }
    poll = setTimeout(() => {
      if (!alive() || document.hidden || busy) { schedule(); return }
      pollAbort = new AbortController()
      void client.refresh(AbortSignal.any([signal, pollAbort.signal])).then(() => {
        if (alive()) paint()
      }).catch(() => { /* Polling failures leave the owned order intact; explicit refresh shows a readable failure. */ })
        .finally(() => { if (alive()) schedule() })
    }, 3000)
  }
  const run = async (work: () => Promise<void>): Promise<void> => {
    if (!alive() || busy) return
    busy = true; stopPolling(); paint()
    try { await work() }
    catch (error) { fail(error) }
    finally { busy = false; if (alive()) { paint(); schedule() } }
  }
  const load = async (): Promise<void> => {
    const data = await client.load(signal)
    if (!alive()) return
    balance.textContent = data.balance === null ? a.unknown : `¥${data.balance}`
    channels = { ...data.channels }
    notice.textContent = channels[gateway].available ? t.note : channels[gateway].reason ?? t.unavailable
  }
  const refresh = action(t.refresh, () => { void run(async () => { notice.textContent = t.checking; await load() }) })
  section.insertBefore(refresh, links)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!alive() || busy || !channels[gateway].available || client.snapshot().locked) return
    let normalized: string
    try { normalized = rechargeAmount(amount.value.trim()) }
    catch { notice.textContent = t.invalid; return }
    if (!confirming) {
      amount.value = normalized; confirming = true
      notice.textContent = `${t.confirming}：¥${normalized}`; paint(); return
    }
    void run(async () => {
      notice.textContent = t.creating; payment = await client.create(normalized, gateway, signal)
      confirming = false; notice.textContent = t.note
    })
  }, { signal })
  amount.addEventListener('input', () => { confirming = false; paint() }, { signal })
  for (const [name, choice] of Object.entries(choices) as [RechargeGateway, HTMLButtonElement][]) {
    choice.addEventListener('click', () => {
      if (!alive() || busy || client.snapshot().locked || !channels[name].available) return
      gateway = name; confirming = false; paint()
    }, { signal })
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPolling(); else schedule() }, { signal })
  void run(load)
}
