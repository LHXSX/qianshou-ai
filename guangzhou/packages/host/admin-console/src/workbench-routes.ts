/** Existing console RBAC and confirmation, with request-scoped service delegation to the workbench. */
import { randomUUID } from 'node:crypto'
import type { Route, RouteContext } from './server.ts'
import type { AuditLog, AuditEntry } from './audit.ts'
import { createWorkbenchUpstream, WorkbenchUpstreamError, type WorkbenchMoneyAction } from './workbench-upstream.ts'

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new WorkbenchUpstreamError(400, 'bad_request', '操作号无效，请重新预览。')
  return value
}
function operation(action: WorkbenchMoneyAction, body: Record<string, unknown>, ref: string): Record<string, unknown> {
  const accountId = text(body['accountId']); const reason = text(body['reason'])
  if (!accountId || reason.length < 4 || reason.length > 200) throw new WorkbenchUpstreamError(400, 'bad_request', '请填写目标账号和至少 4 字、不超过 200 字的操作原因。')
  if (action === 'ledger.adjust') {
    const deltaSp = body['deltaSp']; const bucket = body['bucket'] ?? 'recharge'; const tier = text(body['tier'])
    if (typeof deltaSp !== 'number' || !Number.isFinite(deltaSp) || deltaSp === 0 || (bucket !== 'recharge' && bucket !== 'earning')) throw new WorkbenchUpstreamError(400, 'bad_request', '请填写非零 SP 增量，并选择充值或收益余额。')
    return { accountId, deltaSp, bucket, ...(tier ? { tier } : {}), reason, ref }
  }
  const tier = text(body['tier']); const from = body['from']; const to = body['to']
  if (!tier || typeof from !== 'number' || !Number.isSafeInteger(from) || from < 0 || (to !== null && (typeof to !== 'number' || !Number.isSafeInteger(to) || to <= from))) throw new WorkbenchUpstreamError(400, 'bad_request', '请选择档位、明确生效时间和晚于生效时间的到期时间；不过期必须明确选择。')
  return { accountId, tier, from, to, reason, ref }
}

/** All inputs, including reason and normalized dates, are bound to the existing one-use token. */
export function registerWorkbenchRoutes(options: {
  readonly route: (route: Route) => void
  readonly upstream: ReturnType<typeof createWorkbenchUpstream>
  readonly issueConfirm: (ctx: RouteContext, action: string, payload: Record<string, unknown>, diff: unknown) => void
  readonly consumeConfirm: (ctx: RouteContext, action: string, payload: Record<string, unknown>) => Promise<boolean>
  readonly audit: (draft: Parameters<AuditLog['record']>[0]) => Promise<AuditEntry | null>
}): void {
  for (const [prefix, action, permission] of [
    ['/account/adjustment', 'ledger.adjust', 'account.charge.adjust'],
    ['/subscription/manage', 'subscription.grant', 'subscription.manage'],
  ] as const) {
    for (const stage of ['preflight', 'apply', 'check'] as const) options.route({
      path: `${prefix}/${stage}`, auth: 'permission', permission, mutating: stage === 'apply',
      handler: async (ctx) => {
        let ref: string | null = null
        const auditBase = { actorType: 'admin' as const, actorId: ctx.admin?.accountId ?? '-', actorRole: ctx.role?.id ?? '-', ip: ctx.ip, addressSource: ctx.addressSource, target: `account:${text(ctx.body['accountId'])}`, reason: text(ctx.body['reason']) }
        try {
          if (ctx.scope !== 'all') throw new WorkbenchUpstreamError(403, 'forbidden', 'SP 与订阅管理需要全部数据范围。')
          if (!options.upstream.configured) throw new WorkbenchUpstreamError(503, 'dependency_unavailable', '工作台服务身份尚未配置，当前不能调整 SP 或订阅。')
          ref = stage === 'preflight' ? randomUUID() : uuid(ctx.body['ref'])
          const draft = operation(action, ctx.body, ref)
          const before = record(ctx.body['before'])
          if (stage === 'apply') {
            if (!await options.consumeConfirm(ctx, `workbench.${action}`, { operation: draft, before })) return
            const intent = await options.audit({ ...auditBase, action: `${action}.attempt`, result: 'allow', summary: `管理台提交工作台操作 ${ref}，结果尚未确认`, before, after: { serviceId: 'admin-console', operatorAccountId: ctx.admin?.accountId, operation: draft } })
            if (intent === null) throw new WorkbenchUpstreamError(503, 'workbench_audit_unavailable', '意图审计未写入，尚未向工作台提交修改。')
          }
          const result = await options.upstream.request({ action, operatorAccountId: ctx.admin?.accountId ?? '', operatorRole: ctx.role?.id ?? '', operationId: ref, body: draft, dryRun: stage !== 'apply' })
          if (result['ref'] !== ref) throw new WorkbenchUpstreamError(502, stage === 'apply' ? 'workbench_outcome_unknown' : 'workbench_contract_mismatch', '工作台回执操作号不匹配，请保留操作号核查。')
          if (stage !== 'apply') {
            const preview = record(result['preview']); const rawAfter = record(preview['after'])
            const after = operation(action, rawAfter, uuid(rawAfter['ref']))
            if (after['ref'] !== ref || after['accountId'] !== draft['accountId'] || after['reason'] !== draft['reason'] || (action === 'ledger.adjust' && after['deltaSp'] !== draft['deltaSp'])) throw new WorkbenchUpstreamError(502, 'workbench_contract_mismatch', '工作台预览与请求不一致，本次不能确认。')
            const authoritativeBefore = record(preview['before'])
            const keys = action === 'ledger.adjust' ? ['bucket', ...(draft['tier'] === undefined ? [] : ['tier'])] : ['tier', 'from', 'to']
            if (keys.some(key => after[key] !== draft[key]) || (action === 'ledger.adjust'
              ? typeof authoritativeBefore['purchasableSp'] !== 'number' || !Number.isFinite(authoritativeBefore['purchasableSp']) || !Array.isArray(authoritativeBefore['purchasableBuckets'])
              : !Number.isSafeInteger(authoritativeBefore['historyCount']) || !(authoritativeBefore['tier'] === null || typeof authoritativeBefore['tier'] === 'string'))) throw new WorkbenchUpstreamError(502, 'workbench_contract_mismatch', '工作台预览字段与请求不一致，本次不能确认。')
            if (stage === 'check') ctx.json(200, { ok: true, ref, recorded: result['created'] === false, preview: { before: authoritativeBefore, after } })
            else options.issueConfirm(ctx, `workbench.${action}`, { operation: after, before: authoritativeBefore }, { before: authoritativeBefore, after })
            return
          }
          const business = record(result[action === 'ledger.adjust' ? 'adjustment' : 'subscription'])
          if (business['accountId'] !== draft['accountId'] || typeof result['created'] !== 'boolean' || business['ref'] !== ref || business['reason'] !== draft['reason'] || business['grantedBy'] !== ctx.admin?.accountId || (action === 'ledger.adjust' ? business['sp'] !== draft['deltaSp'] || business['bucket'] !== draft['bucket'] || business['tier'] !== draft['tier'] : business['tier'] !== draft['tier'] || business['from'] !== draft['from'] || business['to'] !== draft['to'])) throw new WorkbenchUpstreamError(502, 'workbench_outcome_unknown', '工作台回执未能确认目标操作，请保留操作号核查，勿另建操作。')
          const audit = await options.audit({ ...auditBase, action: `${action}.apply`, result: 'allow', summary: `工作台已确认操作 ${ref}`, before, after: result })
          if (audit === null) throw new WorkbenchUpstreamError(502, 'workbench_audit_failed', '工作台已返回成功，但结果审计未写入，请用原操作号核查，勿重复提交。')
          ctx.json(200, { ok: true, auditId: audit.id, result })
        } catch (error) {
          if (!(error instanceof WorkbenchUpstreamError)) throw error
          await options.audit({ ...auditBase, action: `${action}.${stage}`, result: error.code.includes('unknown') ? 'error' : 'deny', summary: error.code, after: { serviceId: 'admin-console', ref } })
          ctx.json(error.status, { ok: false, code: error.code, message: error.message, ...(ref === null ? {} : { ref }), ...(error.code === 'dependency_unavailable' ? { module: action === 'ledger.adjust' ? 'account' : 'subscription', missing: [{ interface: action === 'ledger.adjust' ? 'POST /internal/ledger/adjust' : 'POST /internal/subscriptions/grant', why: '需要配置工作台专用服务身份。', owner: '模型网关（工作台进程）' }] } : {}) })
        }
      },
    })
  }
}
