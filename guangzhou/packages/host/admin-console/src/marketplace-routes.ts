/** Guangzhou admin review screen, backed by Shanghai's authoritative queue. */
import type { Route, RouteContext } from './server.ts'
import type { AuditEntry, AuditLog } from './audit.ts'
import { createMarketplaceUpstream, MarketplaceUpstreamError } from './marketplace-upstream.ts'

type MarketplaceUpstream = ReturnType<typeof createMarketplaceUpstream>
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const fields = ['id', 'slug', 'name', 'summary', 'author_name', 'category', 'launch_kind', 'task_type', 'input_kind',
  'pricing_model', 'price', 'status', 'version', 'sha256', 'package_kind', 'updated_at', 'can_approve'] as const

function project(value: unknown): Record<string, unknown> {
  const row = record(value)
  if (typeof row['id'] !== 'number' || !Number.isSafeInteger(row['id']) || typeof row['name'] !== 'string' || typeof row['status'] !== 'string') {
    throw new MarketplaceUpstreamError(502, 'market_contract_mismatch', '上海审核队列返回的条目结构不完整。')
  }
  const safe = Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]]))
  safe['review_issues'] = Array.isArray(row['review_issues'])
    ? row['review_issues'].filter((item): item is string => typeof item === 'string').slice(0, 20).map(item => item.slice(0, 400)) : []
  return safe
}

const publicationFields = ['id', 'owner_id', 'task_type', 'capability_id', 'input_kinds', 'output_kind',
  'contract_version', 'name', 'category', 'description', 'configuration',
  'version', 'artifact_digest', 'package_digest', 'price_yuan', 'sale_price_yuan',
  'market_product_id', 'market_product_status', 'currency', 'status', 'created_at',
  'can_approve', 'can_submit_review', 'required_evidence', 'evidence_kinds'] as const
function projectPublication(value: unknown): Record<string, unknown> {
  const row = record(value)
  if (typeof row['id'] !== 'string' || !/^[0-9a-f-]{36}$/.test(row['id']) ||
      typeof row['name'] !== 'string' || typeof row['task_type'] !== 'string' || typeof row['status'] !== 'string') {
    throw new MarketplaceUpstreamError(502, 'market_contract_mismatch', '上海接单技能投稿结构不完整。')
  }
  const safe = Object.fromEntries(publicationFields.filter(key => row[key] !== undefined).map(key => [key, row[key]]))
  safe['evidence_status'] = Object.fromEntries(Object.entries(record(row['evidence_status']))
    .filter(([kind, status]) => ['package', 'sample', 'pricing', 'review', 'media'].includes(kind)
      && ['missing', 'valid', 'invalid'].includes(String(status))))
  safe['review_reasons'] = Array.isArray(row['review_reasons'])
    ? row['review_reasons'].filter((item): item is string => typeof item === 'string').slice(0, 20).map(item => item.slice(0, 400)) : []
  return safe
}

const productFields = ['id', 'publication_id', 'owner_id', 'task_type', 'name', 'version', 'category',
  'description', 'artifact_digest', 'reviewed_seller_runtime_digest', 'archive_digest',
  'archive_size_bytes', 'sale_price_yuan', 'currency', 'status', 'can_approve',
  'available_to_purchase', 'updated_at'] as const
function projectOrderProduct(value: unknown): Record<string, unknown> {
  const row = record(value)
  if (typeof row['id'] !== 'string' || !/^[0-9a-f-]{36}$/.test(row['id']) ||
      typeof row['publication_id'] !== 'string' || !/^[0-9a-f-]{36}$/.test(row['publication_id']) ||
      typeof row['name'] !== 'string' || typeof row['status'] !== 'string' ||
      row['currency'] !== 'CNY') {
    throw new MarketplaceUpstreamError(502, 'market_contract_mismatch', '上海接单技能商品结构不完整。')
  }
  const safe = Object.fromEntries(productFields.filter(key => row[key] !== undefined).map(key => [key, row[key]]))
  safe['review_reasons'] = Array.isArray(row['review_reasons'])
    ? row['review_reasons'].filter((item): item is string => typeof item === 'string').slice(0, 20).map(item => item.slice(0, 400)) : []
  return safe
}

/** Lifecycle metadata is authority, not a UI-inferred review state. */
function projectManagedPublication(value: unknown): Record<string, unknown> {
  const row = record(value), life = record(row['lifecycle'])
  const actions = life['allowed_actions'], reasons = life['blocking_reasons']
  if (typeof row['publication_id'] !== 'string' || !/^[0-9a-f-]{36}$/.test(row['publication_id'])
    || typeof row['owner_id'] !== 'number' || !Number.isSafeInteger(row['owner_id'])
    || typeof row['name'] !== 'string' || row['name'].length < 1 || row['name'].length > 100
    || typeof row['status'] !== 'string' || !['review', 'approved', 'rejected'].includes(row['status'])
    || typeof life['state'] !== 'string' || !['active', 'withdrawn', 'delisted'].includes(life['state'])
    || typeof life['archived'] !== 'boolean' || typeof life['revision'] !== 'number' || !Number.isSafeInteger(life['revision'])
    || life['revision'] < 0 || !Array.isArray(actions) || actions.length > 4
    || actions.some(action => typeof action !== 'string' || !['withdraw', 'delist', 'archive', 'restore'].includes(action))
    || !Array.isArray(reasons) || reasons.length > 2
    || reasons.some(reason => typeof reason !== 'string' || !['active-orders', 'pending-install'].includes(reason))) {
    throw new MarketplaceUpstreamError(502, 'market_contract_mismatch', '中央服务器发布记录权限回执不完整。')
  }
  return { publication_id: row['publication_id'], owner_id: row['owner_id'], name: row['name'], status: row['status'],
    task_type: row['task_type'], market_product_id: row['market_product_id'], market_product_status: row['market_product_status'],
    lifecycle: { state: life['state'], archived: life['archived'], revision: life['revision'], allowed_actions: actions, blocking_reasons: reasons } }
}

export function registerMarketplaceRoutes(options: {
  readonly route: (route: Route) => void
  readonly upstream: MarketplaceUpstream
  readonly audit: (draft: Parameters<AuditLog['record']>[0]) => Promise<AuditEntry | null>
}): void {
  const access = (ctx: RouteContext): string => {
    if (ctx.scope !== 'all') throw new MarketplaceUpstreamError(403, 'market_scope_forbidden', '市场审核需要全部数据范围。')
    const token = ctx.session?.tokens?.access
    if (!token) throw new MarketplaceUpstreamError(401, 'market_session_required', '请重新登录以取得上海账号会话。')
    return token
  }
  const subject = (ctx: RouteContext): string => {
    const accountId = ctx.admin?.accountId
    if (!accountId || accountId !== ctx.session?.accountId) {
      throw new MarketplaceUpstreamError(403, 'market_identity_mismatch', '管理台身份与上海账号会话不一致。')
    }
    return accountId
  }
  const reviewAuthorization = (queue: Record<string, unknown>) => ({
    reviewAuthorized: queue['reviewAuthorized'] === true && queue['readDelegated'] === false,
    readDelegated: queue['readDelegated'] === true,
  })
  const requireReviewAuthorization = (queue: Record<string, unknown>): void => {
    if (!reviewAuthorization(queue).reviewAuthorized) {
      throw new MarketplaceUpstreamError(403, 'market_review_upstream_forbidden', '上海未授予当前账号审核写权限。')
    }
  }
  const add = (path: string, writing: boolean, handler: (ctx: RouteContext) => Promise<void>): void => {
    options.route({ path: `/market/${path}`, auth: 'permission', permission: writing ? 'market.review' : 'market.read',
      mutating: writing, handler: async ctx => {
        try { await handler(ctx) } catch (error) {
          if (!(error instanceof MarketplaceUpstreamError)) throw error
          ctx.json(error.status, { ok: false, code: error.code, message: error.message })
        }
      } })
  }
  add('reviews', false, async ctx => {
    const raw = ctx.body['limit']
    const limit = raw === undefined ? 50 : raw
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new MarketplaceUpstreamError(400, 'bad_request', '每页数量应为 1–200。')
    }
    const queue = await options.upstream.list(access(ctx), limit, subject(ctx))
    if (!Array.isArray(queue['items'])) throw new MarketplaceUpstreamError(502, 'market_contract_mismatch', '上海未返回待审核队列。')
    ctx.json(200, { ok: true, ...reviewAuthorization(queue), items: queue['items'].map(project) })
  })
  add('review', true, async ctx => {
    const appId = ctx.body['appId']
    const action = ctx.body['action']
    const note = string(ctx.body['note'])
    if (typeof appId !== 'number' || !Number.isSafeInteger(appId) || appId < 1 ||
      (action !== 'approve' && action !== 'reject') || note.length < 4 || note.length > 500) {
      throw new MarketplaceUpstreamError(400, 'bad_request', '请选择投稿、通过或驳回，并填写 4–500 字审核原因。')
    }
    const token = access(ctx)
    const queue = await options.upstream.list(token, 200, subject(ctx))
    if (!Array.isArray(queue['items'])) throw new MarketplaceUpstreamError(502, 'market_contract_mismatch', '上海未返回待审核队列。')
    requireReviewAuthorization(queue)
    const target = queue['items'].map(project).find(item => item['id'] === appId)
    if (!target || target['status'] !== 'review') throw new MarketplaceUpstreamError(409, 'market_review_stale', '投稿已不在待审队列，请刷新后核对。')
    if (action === 'approve' && (target['can_approve'] !== true || (target['review_issues'] as string[]).length > 0)) {
      throw new MarketplaceUpstreamError(409, 'market_review_blocked', '这项投稿仍有平台阻断项，不能审核通过。')
    }
    const auditBase = { actorType: 'admin' as const, actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-',
      ip: ctx.ip, addressSource: ctx.addressSource, action: `market.review.${action}`, target: String(appId), reason: note }
    const attempt = await options.audit({ ...auditBase, result: 'allow', summary: '即将向上海提交市场审核；结果待确认', before: target })
    if (attempt === null) throw new MarketplaceUpstreamError(503, 'market_audit_unavailable', '本地审计不可写，尚未向上海提交。')
    const outcome = await options.upstream.moderate(token, appId, action, note)
    const expected = action === 'approve' ? 'published' : 'rejected'
    if (outcome['id'] !== appId || outcome['status'] !== expected) {
      throw new MarketplaceUpstreamError(502, 'market_review_outcome_unknown', '上海返回的审核状态无法确认。请刷新队列核对，勿重复提交。')
    }
    const safe = project(outcome)
    const done = await options.audit({ ...auditBase, result: 'allow', summary: `上海已受理市场审核：${expected}`, before: target, after: safe })
    if (done === null) throw new MarketplaceUpstreamError(502, 'market_audit_failed', '上海已返回成功，但本地审计结果未写入；请核查上海记录。')
    ctx.json(200, { ok: true, item: safe, auditId: done.id })
  })
  add('order-publications', false, async ctx => {
    const queue = await options.upstream.listOrderPublications(access(ctx), subject(ctx))
    if (!Array.isArray(queue['items'])) throw new MarketplaceUpstreamError(502, 'market_contract_mismatch', '上海未返回接单技能审核队列。')
    ctx.json(200, { ok: true, ...reviewAuthorization(queue), items: queue['items'].map(projectPublication) })
  })
  add('order-publication/review', true, async ctx => {
    const publicationId = string(ctx.body['publicationId'])
    const action = ctx.body['action']
    const note = string(ctx.body['note'])
    if (!/^[0-9a-f-]{36}$/.test(publicationId) || (action !== 'approve' && action !== 'reject') ||
      note.length < 4 || note.length > 500) {
      throw new MarketplaceUpstreamError(400, 'bad_request', '请选择接单技能投稿与审核动作，并填写 4–500 字原因。')
    }
    const token = access(ctx)
    const queue = await options.upstream.listOrderPublications(token, subject(ctx))
    if (!Array.isArray(queue['items'])) throw new MarketplaceUpstreamError(502, 'market_contract_mismatch', '上海未返回接单技能审核队列。')
    requireReviewAuthorization(queue)
    const target = queue['items'].map(projectPublication).find(item => item['id'] === publicationId)
    if (!target || target['status'] !== 'review') throw new MarketplaceUpstreamError(409, 'market_review_stale', '投稿已不在待审队列，请刷新后核对。')
    if (action === 'approve' && target['can_approve'] !== true) {
      throw new MarketplaceUpstreamError(409, 'market_review_blocked', '验包、价格、独立审查或媒体回执尚未由受信服务存证；请刷新后查看缺项。')
    }
    const auditBase = { actorType: 'admin' as const, actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-',
      ip: ctx.ip, addressSource: ctx.addressSource, action: `market.order-publication.${action}`,
      target: publicationId, reason: note }
    const attempt = await options.audit({ ...auditBase, result: 'allow', summary: '即将向上海提交接单技能审核；结果待确认', before: target })
    if (attempt === null) throw new MarketplaceUpstreamError(503, 'market_audit_unavailable', '本地审计不可写，尚未向上海提交。')
    const outcome = action === 'approve'
      ? await options.upstream.approveOrderPublication(token, publicationId, note)
      : await options.upstream.rejectOrderPublication(token, publicationId, note)
    const expected = action === 'approve' ? 'approved' : 'rejected'
    if (outcome['id'] !== publicationId || outcome['status'] !== expected) {
      throw new MarketplaceUpstreamError(502, 'market_review_outcome_unknown', '上海接单技能审核状态无法确认。请核查记录，勿重复提交。')
    }
    const safe = projectPublication(outcome)
    const done = await options.audit({ ...auditBase, result: 'allow', summary: `上海已受理接单技能审核：${expected}`, before: target, after: safe })
    if (done === null) throw new MarketplaceUpstreamError(502, 'market_audit_failed', '上海已返回成功，但广州审计结果未写入；请核查上海记录。')
    ctx.json(200, { ok: true, item: safe, auditId: done.id })
  })
  add('order-adapter-products', false, async ctx => {
    const queue = await options.upstream.listOrderAdapterProducts(access(ctx), subject(ctx))
    if (!Array.isArray(queue['items'])) throw new MarketplaceUpstreamError(502, 'market_contract_mismatch', '上海未返回接单技能商品审核队列。')
    ctx.json(200, { ok: true, ...reviewAuthorization(queue),
      reviewActionsAvailable: queue['reviewActionsAvailable'] === true, items: queue['items'].map(projectOrderProduct) })
  })
  add('order-adapter-product/review', true, async ctx => {
    const productId = string(ctx.body['productId'])
    const action = ctx.body['action']
    const note = string(ctx.body['note'])
    if (!/^[0-9a-f-]{36}$/.test(productId) || (action !== 'approve' && action !== 'reject') ||
      note.length < 4 || note.length > 500) {
      throw new MarketplaceUpstreamError(400, 'bad_request', '请选择接单技能商品与审核动作，并填写 4–500 字原因。')
    }
    const token = access(ctx)
    const queue = await options.upstream.listOrderAdapterProducts(token, subject(ctx))
    if (!Array.isArray(queue['items'])) throw new MarketplaceUpstreamError(502, 'market_contract_mismatch', '上海未返回接单技能商品审核队列。')
    requireReviewAuthorization(queue)
    const target = queue['items'].map(projectOrderProduct).find(item => item['id'] === productId)
    if (!target || target['status'] !== 'review') throw new MarketplaceUpstreamError(409, 'market_review_stale', '商品已不在待审队列，请刷新后核对。')
    if (action === 'approve' && (target['can_approve'] !== true || (target['review_reasons'] as string[]).length > 0)) {
      throw new MarketplaceUpstreamError(409, 'market_review_blocked', '商品归档或接单技能状态尚未通过平台核验。')
    }
    const auditBase = { actorType: 'admin' as const, actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-',
      ip: ctx.ip, addressSource: ctx.addressSource, action: `market.order-adapter-product.${action}`,
      target: productId, reason: note }
    const attempt = await options.audit({ ...auditBase, result: 'allow', summary: '即将向上海提交接单技能商品审核；结果待确认', before: target })
    if (attempt === null) throw new MarketplaceUpstreamError(503, 'market_audit_unavailable', '本地审计不可写，尚未向上海提交。')
    const outcome = action === 'approve'
      ? await options.upstream.approveOrderAdapterProduct(token, productId, note)
      : await options.upstream.rejectOrderAdapterProduct(token, productId, note)
    const expected = action === 'approve' ? 'published' : 'rejected'
    if (outcome['id'] !== productId || outcome['status'] !== expected) {
      throw new MarketplaceUpstreamError(502, 'market_review_outcome_unknown', '上海商品审核状态无法确认。请核查记录，勿重复提交。')
    }
    const safe = projectOrderProduct(outcome)
    const done = await options.audit({ ...auditBase, result: 'allow', summary: `上海已受理接单技能商品审核：${expected}`, before: target, after: safe })
    if (done === null) throw new MarketplaceUpstreamError(502, 'market_audit_failed', '上海已返回成功，但广州审计结果未写入；请核查上海记录。')
    ctx.json(200, { ok: true, item: safe, auditId: done.id })
  })
  add('order-publications/managed', false, async ctx => {
    const queue = await options.upstream.listManagedOrderPublications(access(ctx), subject(ctx))
    requireReviewAuthorization(queue)
    if (!Array.isArray(queue['items'])) throw new MarketplaceUpstreamError(502, 'market_contract_mismatch', '中央服务器未返回发布管理记录。')
    ctx.json(200, { ok: true, ...reviewAuthorization(queue), items: queue['items'].map(projectManagedPublication) })
  })
  add('order-publication/lifecycle', true, async ctx => {
    const id = string(ctx.body['publicationId']), action = ctx.body['action'], revision = ctx.body['expectedRevision']
    const note = string(ctx.body['note'])
    if (!/^[0-9a-f-]{36}$/.test(id) || typeof action !== 'string' || !['withdraw', 'delist', 'archive', 'restore'].includes(action)
      || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || note.length < 4 || note.length > 500) {
      throw new MarketplaceUpstreamError(400, 'bad_request', '请选择准确发布记录、管理动作，并填写 4–500 字原因。')
    }
    const token = access(ctx), queue = await options.upstream.listManagedOrderPublications(token, subject(ctx))
    requireReviewAuthorization(queue)
    if (!Array.isArray(queue['items'])) throw new MarketplaceUpstreamError(502, 'market_contract_mismatch', '中央服务器未返回发布管理记录。')
    const target = queue['items'].map(projectManagedPublication).find(item => item['publication_id'] === id)
    const life = record(target?.['lifecycle'])
    if (!target || life['revision'] !== revision || !Array.isArray(life['allowed_actions']) || !life['allowed_actions'].includes(action)) {
      throw new MarketplaceUpstreamError(409, 'market_lifecycle_stale', '记录已变化或存在在途订单、待安装权益，请刷新后核对。')
    }
    const auditBase = { actorType: 'admin' as const, actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-',
      ip: ctx.ip, addressSource: ctx.addressSource, action: `market.publication.lifecycle.${action}`, target: id, reason: note }
    if (await options.audit({ ...auditBase, result: 'allow', summary: '即将提交发布记录管理，历史合同与账本保留', before: target }) === null) {
      throw new MarketplaceUpstreamError(503, 'market_audit_unavailable', '广州审计不可写，尚未向中央服务器提交。')
    }
    const safe = projectManagedPublication(await options.upstream.manageOrderPublication(token, id,
      action as 'withdraw' | 'delist' | 'archive' | 'restore', revision, note))
    const after = record(safe['lifecycle'])
    if (safe['publication_id'] !== id || after['revision'] !== revision + 1
      || (action === 'archive' && after['archived'] !== true) || (action === 'restore' && after['archived'] !== false)
      || (action === 'withdraw' && after['state'] !== 'withdrawn') || (action === 'delist' && after['state'] !== 'delisted')) {
      throw new MarketplaceUpstreamError(502, 'market_review_outcome_unknown', '管理结果无法确认，请刷新记录核对，勿重复提交。')
    }
    const done = await options.audit({ ...auditBase, result: 'allow', summary: '中央服务器已持久化发布管理动作', before: target, after: safe })
    if (done === null) throw new MarketplaceUpstreamError(502, 'market_audit_failed', '中央服务器已处理，广州审计未写入，请核查历史记录。')
    ctx.json(200, { ok: true, item: safe, auditId: done.id })
  })

}
