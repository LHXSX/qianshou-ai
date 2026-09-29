/**
 * 错误分类是契约里最容易做错的一环，必须由测试盯着：
 * 401 才跳登录；502 绝不能被说成「请重新登录」；403 forbidden 要带 need；
 * 503 要带 module + missing。
 */

import { describe, expect, it } from 'vitest'
import { AdminApiError, errorHint, errorTitle, readMissingDependencies, toAdminApiError, toTransportError } from '../src/api/errors'

describe('toAdminApiError：按 HTTP + code 分类', () => {
  it('401 unauthenticated 是可跳登录的唯一情形', () => {
    const error = toAdminApiError(401, { ok: false, code: 'unauthenticated', message: '未登录' })
    expect(error.isUnauthenticated).toBe(true)
    expect(error.status).toBe(401)
  })

  it('502 upstream_unavailable 不被当成登录问题', () => {
    const error = toAdminApiError(502, { ok: false, code: 'upstream_unavailable', message: '上游账号服务不可达' })
    expect(error.isUpstreamUnavailable).toBe(true)
    expect(error.isUnauthenticated).toBe(false)
    const hint = errorHint(error)
    expect(hint).toContain('账号服务')
    expect(hint).toContain('不是登录态失效')
    // 契约点名：不能把 502 渲染成「请重新登录」
    expect(hint).not.toContain('重新登录')
    expect(hint).not.toContain('会话已失效')
  })

  it('403 forbidden 暴露缺失的权限键 need', () => {
    const error = toAdminApiError(403, { ok: false, code: 'forbidden', message: '权限不足', need: 'audit.read' })
    expect(error.isForbidden).toBe(true)
    expect(error.details.need).toBe('audit.read')
    expect(errorHint(error)).toContain('audit.read')
  })

  it('403 not_an_admin 与 admin_disabled 分开表达', () => {
    const notAdmin = toAdminApiError(403, { ok: false, code: 'not_an_admin', message: '不是管理员' })
    const disabled = toAdminApiError(403, { ok: false, code: 'admin_disabled', message: '已停用' })
    expect(notAdmin.isNotAnAdmin).toBe(true)
    expect(notAdmin.isAdminDisabled).toBe(false)
    expect(disabled.isAdminDisabled).toBe(true)
    expect(errorTitle(notAdmin)).not.toBe(errorTitle(disabled))
  })

  it('403 ip_not_allowed 指向白名单逃生路径', () => {
    const error = toAdminApiError(403, { ok: false, code: 'ip_not_allowed', message: '来源 IP 不在白名单' })
    expect(error.isIpNotAllowed).toBe(true)
    expect(errorHint(error)).toContain('逃生')
  })

  it('503 dependency_unavailable 带 module 与 missing[]', () => {
    const error = toAdminApiError(503, {
      ok: false,
      code: 'dependency_unavailable',
      message: '属主服务未就绪',
      module: 'market',
      missing: [
        { interface: 'GET /internal/market/items', why: '市场条目' },
        { interface: 'POST /internal/market/review', why: '上架审核' },
      ],
    })
    expect(error.isDependencyUnavailable).toBe(true)
    expect(error.details.module).toBe('market')
    expect(error.details.missing?.map(item => item.interface)).toEqual([
      'GET /internal/market/items',
      'POST /internal/market/review',
    ])
  })

  it('409 令牌与版本冲突可区分', () => {
    expect(toAdminApiError(409, { ok: false, code: 'confirm_expired', message: '' }).isConfirmTokenProblem).toBe(true)
    expect(toAdminApiError(409, { ok: false, code: 'version_conflict', message: '' }).isVersionConflict).toBe(true)
  })

  it('code 缺失时用 HTTP 兜底，不产生空洞文案', () => {
    const error = toAdminApiError(418, { ok: false })
    expect(error.code).toBe('http_418')
    expect(error.message).not.toBe('')
  })

  it('服务端 message 优先于前端兜底文案', () => {
    const error = toAdminApiError(400, { ok: false, code: 'bad_request', message: '缺少 accountId' })
    expect(error.message).toBe('缺少 accountId')
  })
})

describe('toTransportError：网络层失败归一', () => {
  it('fetch reject 归类为 transport_unavailable', () => {
    const error = toTransportError(new TypeError('Failed to fetch'))
    expect(error.status).toBe(0)
    expect(error.code).toBe('transport_unavailable')
    expect(error.isUpstreamUnavailable).toBe(false)
    expect(error.message).toContain('Failed to fetch')
  })
})

describe('readMissingDependencies', () => {
  it('忽略形状不对的条目', () => {
    expect(readMissingDependencies({ missing: [{ interface: 'A', why: 'w' }, { why: 'no name' }, 'x'] })).toEqual([
      { interface: 'A', why: 'w' },
    ])
    expect(readMissingDependencies({ missing: 'not-an-array' })).toEqual([])
    expect(readMissingDependencies(null)).toEqual([])
  })
})

describe('AdminApiError', () => {
  it('未提供的 details 归一为空对象', () => {
    const error = new AdminApiError({ status: 500, code: 'internal', message: 'boom' })
    expect(error.details).toEqual({})
    expect(error.isDependencyUnavailable).toBe(false)
  })
})
