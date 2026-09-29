/** Same console RBAC, two-step confirmation and audit; the gateway owns the durable node authorization. */
import { randomUUID } from 'node:crypto'
import type { Route, RouteContext } from './server.ts'
import type { AuditLog, AuditEntry } from './audit.ts'
import { ApiConnectionsError, createApiConnectionsUpstream } from './api-connections-upstream.ts'
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new ApiConnectionsError(400, 'bad_request', '操作号无效。')
  return value
}
const device = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) throw new ApiConnectionsError(400, 'bad_request', '节点标识无效。')
  return value
}
export function registerApiConnectionsRoutes(options: {
  route: (route: Route) => void; upstream: ReturnType<typeof createApiConnectionsUpstream>;
  issueConfirm: (ctx: RouteContext, action: string, payload: Record<string, unknown>, diff: unknown) => void;
  consumeConfirm: (ctx: RouteContext, action: string, payload: Record<string, unknown>) => Promise<boolean>;
  audit: (draft: Parameters<AuditLog['record']>[0]) => Promise<AuditEntry | null>; now?: () => number
}): void {
  const pending = new Map<string, { payload: Record<string, unknown>; expiresAt: number }>()
  const now = options.now ?? Date.now
  options.route({ path: '/api-connections/guide', auth: 'permission', permission: 'apiConnections.read', mutating: false,
    handler: async ctx => {
      if (Object.keys(ctx.body).length !== 0) { ctx.json(400, { ok: false, code: 'bad_request', message: '请求字段无效。' }); return }
      ctx.json(200, await options.upstream.guide(ctx.scope))
    } })
  for (const stage of ['list', 'detail', 'preflight', 'apply', 'check'] as const) options.route({
    path: '/api-connections/' + stage, auth: 'permission', permission: stage === 'list' || stage === 'detail' ? 'apiConnections.read' : 'apiConnections.manage', mutating: stage === 'apply',
    handler: async ctx => {
      let ref: string | undefined
      const actor = ctx.admin?.accountId ?? '-'
      const audit = { actorType: 'admin' as const, actorId: actor, actorRole: ctx.role?.id ?? '-', ip: ctx.ip, addressSource: ctx.addressSource, target: 'node:' + String(ctx.body['deviceId'] ?? '-'), reason: String(ctx.body['reason'] ?? '') }
      try {
        const fields = stage === 'list' ? [] : stage === 'detail' ? ['deviceId'] : stage === 'check' ? ['ref'] : stage === 'preflight' ? ['deviceId', 'action', 'ref'] : ['deviceId', 'action', 'ref', 'token', 'reason']
        if (Object.keys(ctx.body).length !== fields.length || Object.keys(ctx.body).some(k => !fields.includes(k))) throw new ApiConnectionsError(400, 'bad_request', '请求字段无效。')
        ref = stage === 'list' || stage === 'detail' ? randomUUID() : uuid(ctx.body['ref'])
        const call = (action: typeof stage, body: Record<string, unknown>) => options.upstream.request(action, { operatorAccountId: actor, operatorRole: ctx.role?.id ?? '-', scope: ctx.scope, ref: ref!, body })
        if (stage === 'list') { ctx.json(200, await call('list', {})); return }
        if (stage === 'detail') { ctx.json(200, await call('detail', { deviceId: device(ctx.body['deviceId']) })); return }
        if (stage === 'check') { ctx.json(200, await call('check', {})); return }
        const deviceId = device(ctx.body['deviceId']); const action = ctx.body['action']
        if (typeof action !== 'string' || !['pause', 'resume', 'revoke'].includes(action)) throw new ApiConnectionsError(400, 'bad_request', '请选择暂停、恢复或吊销。')
        const key = actor + ':' + ref
        for (const [k, value] of pending) if (value.expiresAt <= now()) pending.delete(k)
        if (stage === 'preflight') {
          const result = await call('preflight', { deviceId, action })
          const preview = row(result['preview']); const before = row(preview['before']); const after = row(preview['after'])
          if (before['deviceId'] !== deviceId || after['deviceId'] !== deviceId || after['authorization'] !== (action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'revoked')) throw new ApiConnectionsError(502, 'api_connections_contract_invalid', '节点预览不匹配。')
          const payload = { deviceId, action, ref, before, scope: ctx.scope }
          pending.set(key, { payload, expiresAt: now() + 60_000 })
          options.issueConfirm(ctx, 'apiConnections.manage', payload, { before, after }); return
        }
        const saved = pending.get(key)
        if (!saved || saved.payload['deviceId'] !== deviceId || saved.payload['action'] !== action || saved.payload['scope'] !== ctx.scope) throw new ApiConnectionsError(409, 'confirm_required', '请先预览同一节点与操作。')
        if (!await options.consumeConfirm(ctx, 'apiConnections.manage', saved.payload)) return
        const reason = ctx.body['reason']
        if (typeof reason !== 'string' || reason.trim() !== reason || reason.length < 4 || reason.length > 200) throw new ApiConnectionsError(400, 'bad_request', '原因需为4到200字。')
        const intent = await options.audit({ ...audit, action: 'apiConnections.attempt', result: 'allow', summary: '向广州提交节点授权操作 ' + ref, before: saved.payload['before'], after: { deviceId, action, ref } })
        if (!intent) throw new ApiConnectionsError(503, 'audit_unavailable', '审计未写入，尚未提交节点操作。')
        const result = await call('apply', { deviceId, action, reason, before: saved.payload['before'] })
        if (result['deviceId'] !== deviceId || result['authorization'] !== (action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'revoked')) throw new ApiConnectionsError(502, 'api_connections_outcome_unknown', '节点回执未匹配，请用原操作号查询。')
        pending.delete(key)
        const receipt = await options.audit({ ...audit, action: 'apiConnections.apply', result: 'allow', summary: '广州确认节点授权操作 ' + ref, before: saved.payload['before'], after: result })
        if (!receipt) throw new ApiConnectionsError(502, 'api_connections_outcome_unknown', '广州已返回成功，管理台结果审计未写入，请查询原操作号。')
        ctx.json(200, { ok: true, ref, result })
      } catch (error) {
        if (!(error instanceof ApiConnectionsError)) throw error
        await options.audit({ ...audit, action: 'apiConnections.' + stage, result: error.code.includes('unknown') ? 'error' : 'deny', summary: error.code, after: { ref } })
        ctx.json(error.status, { ok: false, code: error.code, message: error.message, ...(ref ? { ref } : {}) })
      }
    },
  })
}
