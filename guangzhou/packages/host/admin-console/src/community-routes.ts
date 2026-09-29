/** 广州管理台讨论区审核与活动发布接口。 */
import type { Route, RouteContext } from './server.ts'
import type { AuditEntry, AuditLog } from './audit.ts'
import { CommunityError, type CommunityStore } from './community.ts'

/**
 * 注册审核路由，管理员权限仍由管理台的会话和 RBAC 统一判定。
 * @param options - 路由、数据与审计组件。
 */
export function registerCommunityRoutes(options: {
  readonly route: (route: Route) => void
  readonly store: CommunityStore
  readonly audit: (draft: Parameters<AuditLog['record']>[0]) => Promise<AuditEntry | null>
}): void {
  const add = (path: string, writing: boolean, handler: (ctx: RouteContext) => Promise<void>): void => {
    options.route({ path: `/community/${path}`, auth: 'permission', permission: writing ? 'community.manage' : 'community.read',
      mutating: writing, handler: async ctx => {
        try { await handler(ctx) } catch (error) {
          if (!(error instanceof CommunityError)) throw error
          ctx.json(error.status, { ok: false, code: error.code, message: error.message })
        }
      } })
  }
  const actor = (ctx: RouteContext) => ({ id: ctx.admin!.accountId, name: ctx.admin!.displayName })
  const audit = async (ctx: RouteContext, action: string, target: string, note: string, stage: 'attempt' | 'done', after?: unknown): Promise<void> => {
    const receipt = await options.audit({ actorType: 'admin', actorId: ctx.admin!.accountId, actorRole: ctx.role!.id,
      ip: ctx.ip, addressSource: ctx.addressSource, action: `community.${action}.${stage}`, target,
      result: 'allow', reason: note, summary: `讨论区${action}${stage === 'attempt' ? '提交' : '完成'}`,
      ...(after === undefined ? {} : { after }) })
    if (receipt === null) throw new CommunityError(stage === 'attempt' ? 503 : 502, 'audit_unavailable',
      stage === 'attempt' ? '审计记录不可写，操作未提交。' : '操作已执行，但审计回执未写入，请刷新核对。')
  }
  add('list', false, async ctx => { ctx.json(200, { ok: true, ...await options.store.adminList() }) })
  add('moderate', true, async ctx => {
    const id = ctx.body['id']
    const action = ctx.body['action']
    const note = ctx.body['note']
    if (typeof id !== 'string' || !['hide', 'restore', 'pin', 'unpin'].includes(String(action)) || typeof note !== 'string') {
      throw new CommunityError(400, 'bad_request', '请选择讨论、处理方式并填写原因。')
    }
    await audit(ctx, `topic.${action}`, id, note, 'attempt')
    const result = await options.store.moderate(actor(ctx), id, action as 'hide' | 'restore' | 'pin' | 'unpin', note)
    await audit(ctx, `topic.${action}`, id, note, 'done', result.topic)
    ctx.json(200, { ok: true, topic: result.topic })
  })
  add('report/resolve', true, async ctx => {
    const id = ctx.body['id']
    const action = ctx.body['action']
    const note = ctx.body['note']
    if (typeof id !== 'string' || (action !== 'hide' && action !== 'dismiss') || typeof note !== 'string') {
      throw new CommunityError(400, 'bad_request', '请选择举报、处理方式并填写原因。')
    }
    await audit(ctx, `report.${action}`, id, note, 'attempt')
    const result = await options.store.resolveReport(actor(ctx), id, action, note)
    await audit(ctx, `report.${action}`, id, note, 'done', result.report)
    ctx.json(200, { ok: true, report: result.report })
  })
  add('announcement/create', true, async ctx => {
    const title = ctx.body['title']
    const content = ctx.body['content']
    const note = typeof title === 'string' ? title : ''
    await audit(ctx, 'announcement.create', '-', note, 'attempt')
    const topic = await options.store.createTopic(actor(ctx), { category: 'activities', title, content, related: ctx.body['related'] }, true)
    await audit(ctx, 'announcement.create', topic.id, note, 'done', topic)
    ctx.json(200, { ok: true, topic })
  })
}
