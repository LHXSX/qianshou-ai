/** The existing admin HTTP/RBAC/confirmation pipeline owns this payment projection. */
import type { Route, RouteContext } from './server.ts'
import type { AuditLog, AuditEntry } from './audit.ts'
import { hashPayload } from './confirm.ts'
import { createPaymentUpstream, PaymentUpstreamError } from './payment-upstream.ts'

const str = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const identifier = (value: unknown): string => {
  const text = str(value)
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(text)) throw new PaymentUpstreamError(400, 'bad_request', '请输入有效的订单号、提现单号或账号 ID。')
  return text
}
const number = (value: unknown, fallback: number, max: number): number => {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new PaymentUpstreamError(400, 'bad_request', '分页参数无效。')
  return value
}
const orderKeys = ['order_no', 'account_id', 'amount', 'currency', 'gateway', 'status', 'ledger_id', 'gateway_order_id', 'gateway_tx_id', 'created_at', 'paid_at', 'expired_at', 'remark']
const withdrawKeys = ['request_no', 'account_id', 'amount', 'currency', 'status', 'kyc_status', 'review_note', 'paid_tx_id', 'created_at', 'paid_at', 'remark', 'payee_info']
const pick = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const source = object(value)
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]))
}
const order = (value: unknown): Record<string, unknown> => {
  const row = pick(value, orderKeys)
  if (typeof row['order_no'] !== 'string' || typeof row['amount'] !== 'string' || typeof row['status'] !== 'string' || row['account_id'] === undefined) throw new PaymentUpstreamError(502, 'payment_contract_mismatch', '上海订单管理接口返回的结构不完整。')
  return row
}
const withdraw = (value: unknown): Record<string, unknown> => {
  const row = pick(value, withdrawKeys)
  if (typeof row['request_no'] !== 'string' || typeof row['amount'] !== 'string' || typeof row['status'] !== 'string') throw new PaymentUpstreamError(502, 'payment_contract_mismatch', '上海提现接口返回的结构不完整。')
  // Allowlisted business recipient fields come from Shanghai's payee_info.
  // Its account number is masked there; holder/bank names may remain present.
  // The separate payee_info_full object is intentionally excluded.
  row['payee_info'] = pick(row['payee_info'], ['kind', 'account_no', 'holder_name', 'bank_name'])
  return row
}

/** Register only implemented Shanghai operations; refunds, SP changes and ledger deletion have no route. */
export function registerPaymentRoutes(options: {
  readonly route: (route: Route) => void
  readonly upstream: ReturnType<typeof createPaymentUpstream>
  readonly issueConfirm: (ctx: RouteContext, action: string, payload: Record<string, unknown>, diff: unknown) => void
  readonly consumeConfirm: (ctx: RouteContext, action: string, payload: Record<string, unknown>) => Promise<boolean>
  readonly audit: (draft: Parameters<AuditLog['record']>[0]) => Promise<AuditEntry | null>
}): void {
  const send = async (ctx: RouteContext, path: string, body?: Record<string, unknown>) => {
    const access = ctx.session?.tokens?.access
    if (!access) throw new PaymentUpstreamError(401, 'payment_session_required', '请重新登录以取得上海账号会话。')
    return await options.upstream(access, path, body)
  }
  const add = (path: string, writing: boolean, run: (ctx: RouteContext) => Promise<void>): void => { options.route({
    path: `/payment/${path}`, auth: 'permission', permission: writing ? 'payment.manage' : 'payment.read', mutating: writing,
    handler: async (ctx) => {
      try {
        if (ctx.scope !== 'all') throw new PaymentUpstreamError(403, 'payment_scope_forbidden', '支付管理需要全部数据范围；当前管理员只能查看本人数据。')
        if (!ctx.session?.tokens?.access) throw new PaymentUpstreamError(401, 'payment_session_required', '请重新登录以取得上海账号会话。')
        await run(ctx)
      } catch (error) {
        if (!(error instanceof PaymentUpstreamError)) throw error
        if (writing) await options.audit({ actorType: 'admin', actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-', ip: ctx.ip, addressSource: ctx.addressSource, action: `payment.${path}`, target: str(ctx.body['order_no']) || str(ctx.body['request_no']) || str(ctx.body['account_id']) || '-', result: error.code === 'payment_outcome_unknown' ? 'error' : 'deny', reason: str(ctx.body['reason']), summary: error.code })
        ctx.json(error.status, { ok: false, code: error.code, message: error.message })
      }
    },
  }) }
  const pending = async (ctx: RouteContext) => {
    const response = await send(ctx, '/admin/payment/withdraw/pending?limit=200')
    if (!Array.isArray(response['items'])) throw new PaymentUpstreamError(502, 'payment_contract_mismatch', '上海未返回提现队列。')
    return response['items'].map(withdraw)
  }
  add('orders', false, async (ctx) => {
    const limit = number(ctx.body['limit'], 30, 100)
    if (limit === 0) throw new PaymentUpstreamError(400, 'bad_request', '每页数量至少为 1。')
    const offset = number(ctx.body['offset'], 0, 1_000_000)
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    for (const key of ['account_id', 'status', 'gateway']) if (str(ctx.body[key])) query.set(key, identifier(ctx.body[key]))
    const response = await send(ctx, `/admin/payment/orders?${query.toString()}`)
    if (!Array.isArray(response['items']) || typeof response['total'] !== 'number') throw new PaymentUpstreamError(502, 'payment_contract_mismatch', '上海未返回全局订单列表。')
    ctx.json(200, { ok: true, items: response['items'].map(order), total: response['total'], limit, offset })
  })
  add('order', false, async (ctx) => { ctx.json(200, { ok: true, order: order(await send(ctx, `/admin/payment/orders/${identifier(ctx.body['order_no'])}`)) }) })
  add('withdrawals', false, async (ctx) => { const items = await pending(ctx); ctx.json(200, { ok: true, items, total: items.length, limit: 200 }) })

  const draftOf = (body: Record<string, unknown>): Record<string, unknown> => {
    const op = str(body['op'])
    if (op === 'mark_paid') throw new PaymentUpstreamError(503, 'payment_withdrawal_gate', '提现打款登记暂未开放，须先完成上海资金锁修复与审查；当前未提交登记。')
    if (op === 'confirm') {
      const tx = str(body['gateway_tx_id'])
      if (!tx || tx.length > 128) throw new PaymentUpstreamError(400, 'bad_request', '请填写核对后的交易流水号（不超过 128 字）。')
      return { op, order_no: identifier(body['order_no']), gateway_tx_id: tx }
    }
    if (op === 'recharge') {
      const id = identifier(body['account_id']); const amount = str(body['amount'])
      if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 1_000_000 || !/^\d+$/.test(id)) throw new PaymentUpstreamError(400, 'bad_request', '充值金额须大于 0、最多两位小数且不超过 100 万元；账号 ID 须为数字。')
      return { op, account_id: id, amount }
    }
    if (['approve', 'reject', 'mark_paid'].includes(op)) {
      const draft: Record<string, unknown> = { op, request_no: identifier(body['request_no']) }
      if (op === 'mark_paid') {
        const tx = str(body['paid_tx_id'])
        if (!tx || tx.length > 128) throw new PaymentUpstreamError(400, 'bad_request', '请填写已完成打款的交易流水号。')
        draft['paid_tx_id'] = tx
      }
      return draft
    }
    throw new PaymentUpstreamError(400, 'bad_request', '未开放此支付操作。')
  }
  const beforeOf = async (ctx: RouteContext, draft: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (draft['op'] === 'confirm') {
      const row = order(await send(ctx, `/admin/payment/orders/${String(draft['order_no'])}`))
      if (row['status'] !== 'pending' || !['admin_manual', 'bank_transfer'].includes(String(row['gateway']))) throw new PaymentUpstreamError(409, 'payment_state_conflict', '仅待支付的手工充值或银行转账订单可手工确认。')
      return row
    }
    if (draft['op'] === 'recharge') return { account_id: draft['account_id'], balance: null }
    const row = (await pending(ctx)).find(value => value['request_no'] === draft['request_no'])
    if (!row) throw new PaymentUpstreamError(409, 'payment_state_conflict', '提现单已不在当前审批队列，请刷新核查。')
    const allowed = draft['op'] === 'mark_paid' ? ['approved'] : draft['op'] === 'approve' ? ['pending'] : ['pending', 'approved']
    if (!allowed.includes(String(row['status']))) throw new PaymentUpstreamError(409, 'payment_state_conflict', '提现状态已变化，请刷新后重新预览。')
    return row
  }
  add('preflight', true, async (ctx) => {
    const draft = draftOf(ctx.body); const before = await beforeOf(ctx, draft)
    options.issueConfirm(ctx, 'payment', { ...draft, before }, { before, after: draft })
  })
  add('apply', true, async (ctx) => {
    const draft = draftOf(ctx.body); const before = object(ctx.body['before'])
    if (!await options.consumeConfirm(ctx, 'payment', { ...draft, before })) return
    const current = await beforeOf(ctx, draft)
    if (hashPayload(current) !== hashPayload(before)) throw new PaymentUpstreamError(409, 'payment_state_conflict', '预览之后目标状态已变化，请刷新后重新核对。')
    const reason = str(ctx.body['reason'])
    const op = String(draft['op'])
    const auditBase = { actorType: 'admin' as const, actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-', ip: ctx.ip, addressSource: ctx.addressSource, target: String(draft['order_no'] ?? draft['request_no'] ?? draft['account_id']), reason }
    const attempt = await options.audit({ ...auditBase, action: `payment.${op}.attempt`, result: 'allow', summary: '即将向上海提交，结果尚未确认', before, after: draft })
    if (attempt === null) throw new PaymentUpstreamError(503, 'payment_audit_unavailable', '本地审计不可写，尚未向上海提交。')
    const result = op === 'confirm'
      ? await send(ctx, '/admin/payment/confirm', { order_no: draft['order_no'], gateway_tx_id: draft['gateway_tx_id'] })
      : op === 'recharge'
        ? await send(ctx, `/admin/users/${String(draft['account_id'])}/recharge`, { amount: draft['amount'], reason })
        : await send(ctx, `/admin/payment/withdraw/${op}`, { request_no: draft['request_no'], ...(op === 'mark_paid' ? { paid_tx_id: draft['paid_tx_id'] } : { note: reason }) })
    const returned = object(result[op === 'confirm' ? 'order' : 'withdraw'])
    const validResult = op === 'recharge'
      ? typeof result['new_balance'] === 'number' && Number.isFinite(result['new_balance'])
      : op === 'confirm'
        ? returned['order_no'] === draft['order_no'] && returned['status'] === 'paid'
        : returned['request_no'] === draft['request_no'] && returned['status'] === ({ approve: 'approved', reject: 'rejected', mark_paid: 'paid' } as Record<string, string>)[op]
    if (!validResult) throw new PaymentUpstreamError(502, 'payment_outcome_unknown', '上海响应未能确认目标操作结果，请先核查上海账本，勿重复提交。')
    const safeResult = op === 'recharge' ? { new_balance: result['new_balance'] }
      : op === 'confirm' ? pick(result['order'], orderKeys) : withdraw(result['withdraw'])
    const entry = await options.audit({ actorType: 'admin', actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-', ip: ctx.ip, addressSource: ctx.addressSource, action: `payment.${op}.apply`, target: String(draft['order_no'] ?? draft['request_no'] ?? draft['account_id']), result: 'allow', reason, summary: `上海已受理 ${op}`, before, after: safeResult })
    if (entry === null) throw new PaymentUpstreamError(502, 'payment_audit_failed', '上海已返回成功，但本地结果审计未写入。请核查上海账本，勿重复提交。')
    ctx.json(200, { ok: true, auditId: entry.id, result: safeResult })
  })
}
