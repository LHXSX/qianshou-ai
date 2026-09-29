/**
 * 传输层测试：信封校验、401 钩子、网络失败归一。
 * 用一个假的 fetch 覆盖契约里点名的几条分支，不需要真实后端。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdminApiError } from '../src/api/errors'
import { onUnauthorized, postJson } from '../src/api/client'

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  onUnauthorized(() => {})
})

describe('postJson', () => {
  it('一律 POST + JSON，并带同源凭据', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, value: 7 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await postJson<{ ok: true; value: number }>('/api/qianshou/ai/admin/flags/list', { limit: 1 })
    expect(result.value).toBe(7)

    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/qianshou/ai/admin/flags/list')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    expect(init.body).toBe(JSON.stringify({ limit: 1 }))
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('401 触发未授权回调并抛出 AdminApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { ok: false, code: 'unauthenticated', message: '会话失效' })))
    const handler = vi.fn()
    onUnauthorized(handler)

    await expect(postJson('/api/qianshou/ai/admin/session/me')).rejects.toBeInstanceOf(AdminApiError)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('403 forbidden 不触发未授权回调（已登录但缺权限）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { ok: false, code: 'forbidden', message: '缺权限', need: 'rbac.read' })))
    const handler = vi.fn()
    onUnauthorized(handler)

    const error = await postJson('/api/qianshou/ai/admin/rbac/roles/list').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AdminApiError)
    expect((error as AdminApiError).details.need).toBe('rbac.read')
    expect(handler).not.toHaveBeenCalled()
  })

  it('502 不触发未授权回调（不是登录问题）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(502, { ok: false, code: 'upstream_unavailable', message: '上游不可达' })))
    const handler = vi.fn()
    onUnauthorized(handler)

    const error = await postJson('/api/qianshou/ai/admin/session/me').catch((caught: unknown) => caught)
    expect((error as AdminApiError).isUpstreamUnavailable).toBe(true)
    expect(handler).not.toHaveBeenCalled()
  })

  it('200 但缺少 ok:true 信封 → unexpected_response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { entries: [] })))
    const error = await postJson('/api/qianshou/ai/admin/audit/list').catch((caught: unknown) => caught)
    expect((error as AdminApiError).code).toBe('unexpected_response')
  })

  it('白名单拒绝返回纯文本时保留可读信息', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('your IP is not allowed', { status: 403, headers: { 'content-type': 'text/plain' } })),
    )
    const error = await postJson('/api/qianshou/ai/admin/session/me').catch((caught: unknown) => caught)
    expect((error as AdminApiError).status).toBe(403)
    expect((error as AdminApiError).message).toContain('your IP is not allowed')
  })

  it('fetch 抛错归一为 transport_unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    const error = await postJson('/api/qianshou/ai/admin/health').catch((caught: unknown) => caught)
    expect((error as AdminApiError).code).toBe('transport_unavailable')
  })
})
