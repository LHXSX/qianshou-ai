/** A quote-confirm-pay flow over Shanghai CNY, with recoverable fulfilment. */
import { SubscriptionFailure, type CnyOrder, type CnyQuote, type CnyQuoteResult, type CnySubscriptionClient } from './account-subscription-client.ts'
import type { CommercePageOptions } from './account-commerce-pages.ts'
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node
}
const button = (text: string, action: () => void, secondary = false): HTMLButtonElement => {
  const node = el('button', secondary ? 'account-secondary' : 'account-primary', text); node.type = 'button'; node.addEventListener('click', action); return node
}
const message = (error: unknown): string => error instanceof SubscriptionFailure ? error.message : '暂时没有确认结果，请查询原订单。'
const format = (value: number): string => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
function orderView(options: CommercePageOptions, client: CnySubscriptionClient, order: CnyOrder): void {
  if (!options.current()) return
  const { container } = options; container.replaceChildren()
  const card = el('section', 'account-purchase-confirm'); card.dataset.testid = 'account-cny-order'
  card.append(el('span', 'account-badge', order.status === 'fulfilled' ? '已开通' : '已支付'),
    el('h3', '', order.status === 'fulfilled' ? '订阅已开通' : '权益正在确认'),
    el('strong', 'account-plan-price', `¥${order.amountYuan}`),
    el('p', 'account-muted', order.status === 'fulfilled' ? '余额支付完成，订阅有效期已更新。使用仍遵循套餐额度与短时限额。' : '余额已支付。请查询本单进度，无需再次购买。'),
    el('code', 'account-order-number', order.orderId))
  if (order.subscription) card.append(el('p', 'account-muted', `有效期至 ${new Date(order.subscription.to).toLocaleDateString('zh-CN')}`))
  const status = el('p', 'account-purchase-status'); status.setAttribute('role', 'status')
  const check = button(order.canRetry ? '继续开通' : '查询进度', () => {
    check.disabled = true; status.textContent = '正在查询…'
    void (order.canRetry ? client.retry(order, options.signal) : client.recover(options.signal)).then((next) => {
      if (!options.current()) return
      if (next) orderView(options, client, next)
      else status.textContent = '暂时未能确认，请保留订单号后再查询。'
    }).catch((error) => { if (options.current()) status.textContent = message(error) }).finally(() => { check.disabled = false })
  }, true)
  if (order.status !== 'fulfilled') card.append(check)
  else if (options.purchaseIntent) options.purchaseIntent.tier = null
  card.append(status, button('返回额度与订阅', () => { options.navigate('commerce') }, true)); container.append(card)
}
function payView(options: CommercePageOptions, client: CnySubscriptionClient, quote: CnyQuote, wallet?: CnyQuoteResult['wallet']): void {
  if (!options.current()) return
  const { container } = options; container.replaceChildren()
  const card = el('section', 'account-purchase-confirm'); card.dataset.testid = 'account-cny-confirm'
  card.append(el('span', 'account-eyebrow', '余额支付'), el('h3', '', quote.label),
    el('strong', 'account-plan-price', `¥${quote.amountYuan}`), el('p', 'account-muted', '一个月 · 不自动续费'))
  card.append(el('p', 'account-purchase-note', '同档续费延长有效期，不会重置本月已用额度或近 5 小时用量。升级后按新套餐限额使用。'))
  if (wallet) card.append(el('p', '', `账户余额 ¥${wallet.balanceYuan}`))
  card.append(el('p', 'account-muted', `每月 ${format(quote.monthlySp)} SP 使用额度。支付金额为人民币，历史 SP 余额保留。`))
  const status = el('p', 'account-purchase-status'); status.setAttribute('role', 'status')
  const pay = button(`确认支付 ¥${quote.amountYuan}`, () => {
    pay.disabled = true; back.disabled = true; status.textContent = '正在确认支付…'
    void client.purchase(quote, options.signal).then((order) => { if (options.current()) orderView(options, client, order) })
      .catch((error) => {
        if (!options.current()) return
        status.textContent = message(error)
        if (error instanceof SubscriptionFailure && ['insufficient-balance', 'quote-expired', 'invalid-quote'].includes(error.code)) {
          pay.remove()
          card.append(button(error.code === 'insufficient-balance' ? '充值后继续购买' : '重新确认价格', () => {
            if (options.purchaseIntent) options.purchaseIntent.tier = quote.tier
            options.navigate(error.code === 'insufficient-balance' ? 'recharge' : 'commerce')
          }))
        } else if (client.pending() === null) {
          pay.remove(); card.append(button('返回套餐', () => { options.navigate('commerce') }))
        } else { pay.remove(); card.append(button('查询这笔购买', () => { recoverView(options, client) })) }
      }).finally(() => { if (options.current()) back.disabled = false })
  })
  const back = button('返回套餐', () => { options.navigate('commerce') }, true)
  if (wallet && !wallet.canPay) {
    card.append(el('p', 'account-balance-shortfall', `还差 ¥${(wallet.shortfallFen / 100).toFixed(2)}`),
      button('充值后继续购买', () => { if (options.purchaseIntent) options.purchaseIntent.tier = quote.tier; options.navigate('recharge') }))
  } else card.append(pay)
  card.append(status, back); container.append(card)
}
function recoverView(options: CommercePageOptions, client: CnySubscriptionClient): void {
  const pending = client.pending(); if (!pending) { options.navigate('commerce'); return }
  options.container.replaceChildren(el('p', 'account-muted', '正在查询原订单…'))
  void client.recover(options.signal).then((order) => {
    if (!options.current()) return
    if (order) orderView(options, client, order)
    else payView(options, client, pending.quote)
  }).catch((error) => {
    if (!options.current()) return
    options.container.replaceChildren(el('p', 'account-muted', message(error)), button('重新查询原订单', () => { recoverView(options, client) }, true))
  })
}
/** Server catalog for browsing, then a Shanghai quote for the exact payment amount. */
export function renderCnySubscriptionPage(options: CommercePageOptions): void {
  const { container, reader } = options; container.dataset.testid = 'account-commerce'
  const client = reader?.subscription
  if (!reader || !client) { container.append(el('p', 'account-muted', '订阅服务正在连接，请稍后重试。')); return }
  const summary = el('section', 'account-wallet-summary')
  const balance = el('strong', 'account-wallet-amount', '—')
  summary.append(el('span', 'account-eyebrow', '账户余额'), balance,
    button('充值', () => { options.navigate('recharge') }, true))
  const quota = el('section', 'account-usage-summary')
  const plans = el('section', 'account-plan-list')
  container.append(summary, quota, plans)
  if (client.pending()) container.append(button('有一笔购买待确认 · 查看进度', () => { recoverView(options, client) }, true))
  void client.wallet(options.signal).then((wallet) => {
    if (options.current()) balance.textContent = `¥${wallet.balanceYuan}`
  }).catch(() => { if (options.current()) balance.textContent = '暂未读取' })
  const select = (tier: string, control: HTMLButtonElement): void => {
    if (client.pending()) { recoverView(options, client); return }
    control.disabled = true; const before = control.textContent; control.textContent = '正在确认报价…'
    void client.quote(tier, options.signal).then((result) => {
      if (options.current()) payView(options, client, result.quote, result.wallet)
    }).catch((error) => {
      if (!options.current()) return
      let state = container.querySelector<HTMLElement>('.account-quote-error')
      if (!state) { state = el('p', 'account-quote-error'); state.setAttribute('role', 'status'); plans.before(state) }
      state.textContent = message(error)
    }).finally(() => { if (options.current()) { control.disabled = false; control.textContent = before } })
  }
  if (options.purchaseIntent?.tier) {
    const tier = options.purchaseIntent.tier
    const resume = button('充值完成，继续确认订阅', () => { select(tier, resume) })
    plans.before(resume)
  }
  void reader.status(options.signal).then((data) => {
    if (!options.current()) return
    quota.append(el('strong', '', data.tierLabel || '当前订阅'),
      el('span', '', `剩余使用额度 ${data.remainingSp === null ? '—' : format(data.remainingSp)} SP`))
    if (data.windowLimitSp != null && data.usedInWindowSp != null) {
      quota.append(el('small', '', `近 5 小时已用 ${format(data.usedInWindowSp)} / ${format(data.windowLimitSp)} SP`),
        el('small', '', `短时剩余 ${format(Math.max(0, data.windowLimitSp - data.usedInWindowSp))} SP，随使用记录滚动恢复。`))
    }
    quota.append(el('small', 'account-renewal-note', '同档续费只延长有效期，不重置当前已用额度。'))
    plans.append(el('h3', 'account-section-title', '选择订阅'))
    for (const plan of data.plans.filter(item => item.id !== 'free')) {
      const card = el('article', `account-plan${plan.id === data.tierId ? ' is-current' : ''}`); card.dataset.planId = plan.id
      const heading = el('div', 'account-plan-heading'); heading.append(el('h3', '', plan.label))
      if (plan.id === data.tierId) heading.append(el('span', 'account-badge', '当前订阅'))
      card.append(heading, el('p', 'account-plan-price', plan.monthlyYuan === null ? '价格待查询' : `¥${format(plan.monthlyYuan)} / 月`),
        el('p', 'account-muted', `每月 ${plan.monthlySp === null ? '—' : format(plan.monthlySp)} SP 使用额度`))
      const control = button(plan.id === data.tierId ? '续费此订阅' : '查看并选择', () => { select(plan.id, control) }, true)
      card.append(control); plans.append(card)
    }
    container.append(el('p', 'account-ledger-note', '订阅从账户人民币余额支付。SP 为使用额度，购买前请确认本次报价。'))
  }).catch(() => {
    if (options.current()) plans.append(el('p', 'account-muted', '暂时无法读取订阅，请重试。'), button('重新读取', () => { options.navigate('commerce') }, true))
  })
}
