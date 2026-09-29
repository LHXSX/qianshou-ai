/** Full-page commerce views over existing account and gateway services. */
import { accountCopy as t } from './account-copy.ts'
import type { CommerceReader } from './account-commerce.ts'
import { renderCnySubscriptionPage } from './account-subscription-page.ts'
import { renderAccountRecharge } from './account-recharge.ts'

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const value = document.createElement(tag); value.className = className; value.textContent = text; return value
}
const action = (label: string, run: () => void, className = 'account-primary'): HTMLButtonElement => {
  const value = node('button', className, label); value.type = 'button'; value.addEventListener('click', run); return value
}
const format = (value: number | null | undefined): string => value == null ? t.unknown : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const channelLabel = (value: string): string => ({
  alipay: t.alipay, wechat_pay: t.wechatPay, admin_manual: t.manualPay, bank_transfer: t.bankTransfer,
})[value] ?? value
const statusLabel = (value: string): string => ({
  paid: t.paid, pending: t.pendingPayment, failed: t.failedPayment, cancelled: t.cancelledPayment, expired: t.expiredPayment,
})[value] ?? t.unrecognizedPayment
/** One mounted page owns reads; old responses cannot replace a different page. */
export interface CommercePageOptions {
  readonly purchaseIntent?: { tier: string | null }
  readonly container: HTMLElement
  readonly reader?: CommerceReader
  readonly signal: AbortSignal
  readonly current: () => boolean
  readonly navigate: (page: 'commerce' | 'recharge' | 'orders') => void
}
function unavailable(container: HTMLElement, message: string = t.commerceUnavailable): void {
  const state = node('div', 'account-empty'); state.setAttribute('role', 'status')
  state.append(node('strong', '', t.unknown), node('p', '', message)); container.append(state)
}
/** Compact account-home balance summary without expanding a full storefront. */
export function renderAccountQuota(options: CommercePageOptions): void {
  const section = node('section', 'account-quota-card'); section.dataset.testid = 'account-quota'
  const currentPlan = node('strong', 'account-quota-plan', t.commerceLoading)
  section.append(node('span', 'account-eyebrow', t.currentPlan), currentPlan)
  const routes = node('div', 'account-quick-actions')
  routes.append(action(t.commercePurchase, () =>{  options.navigate('recharge') }, 'account-secondary'),
    action(t.commerceSubscribe, () =>{  options.navigate('commerce') }))
  section.append(routes); options.container.append(section)
  const reader = options.reader
  if (!reader) { currentPlan.textContent = t.unknown; return }
  void reader.status(options.signal).then((data) => {
    if (!options.current()) return
    currentPlan.textContent = data.tierLabel || t.unknown
    const facts = node('div', 'account-quota-facts')
    facts.append(node('span', '', `${t.commerceRemaining} ${format(data.remainingSp)} SP`),
      node('span', '', '人民币余额支付订阅'))
    routes.before(facts)
  }).catch(() => { if (options.current()) currentPlan.textContent = t.unknown })
}
/** Recharge stays in the account surface and opens only the validated Alipay form after confirmation. */
export function renderRechargePage(options: CommercePageOptions): void {
  renderAccountRecharge({ ...options, ...(options.reader?.recharge ? { client: options.reader.recharge } : {}) })
}
/** Order reads preserve server status and never infer payment from a checkout redirect. */
export function renderOrdersPage(options: CommercePageOptions): void {
  const { container, reader } = options
  container.dataset.testid = 'account-orders'; container.append(node('p', 'account-page-intro', t.ordersHint))
  if (!reader?.orders) { unavailable(container); return }
  const loading = node('p', 'account-muted', t.loading); loading.setAttribute('role', 'status'); container.append(loading)
  void reader.orders(options.signal).then((rows) => {
    if (!options.current()) return
    loading.remove()
    if (!rows.length) { unavailable(container, t.noOrders); return }
    for (const row of rows) {
      const card = node('article', 'account-order')
      const heading = node('div', 'account-order-heading')
      const amount = Number(row.amount)
      heading.append(node('strong', '', `${row.currency === 'CNY' ? '¥' : row.currency + ' '}${Number.isFinite(amount) ? amount.toFixed(2) : row.amount}`),
        node('span', row.status === 'paid' ? 'account-badge account-badge-success' : 'account-badge', statusLabel(row.status)))
      card.append(heading, node('p', '', channelLabel(row.gateway)), node('code', '', row.orderNo))
      if (row.createdAt) { const date = new Date(row.createdAt); if (Number.isFinite(date.getTime())) card.append(node('small', 'account-muted', date.toLocaleString('zh-CN'))) }
      container.append(card)
    }
  }).catch(() => { if (options.current()) loading.textContent = t.failed })
}
/** New subscriptions are paid from the Shanghai CNY wallet. */
export function renderSubscriptionPage(options: CommercePageOptions): void { renderCnySubscriptionPage(options) }
