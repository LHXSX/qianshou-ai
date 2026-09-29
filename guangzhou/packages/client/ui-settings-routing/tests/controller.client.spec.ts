/**
 * 控制台请求层的规格测试：目录读取、追加绑定，以及**失败如实呈现**。
 *
 * 传输层是注入的，所以这里跑的是真实的控制器代码，只是把 fetch 换成假的。
 * 重点：401 / 403 / 400 三种失败必须被分别表达，服务端的中文原因原样带上去。
 */

import { describe, expect, it, vi } from 'vitest'
import { RouteConsoleController } from '../src/client/controller.ts'
import { ADMIN_BIND_PATH, ADMIN_NAMES_PATH, INVALID_ROUTE_RESPONSE, type BindRequestPayload } from '../src/client/route-catalog.ts'
import { HOUR, NOW, activeBinding, bindPayload, catalog, namesPayload } from './fixtures.ts'

/** 只在目录读取上成功的假传输层。 */
function transport(overrides: Partial<Record<'names' | 'bind', Response>> = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const path = String(input)
    if (path === ADMIN_NAMES_PATH) return overrides.names ?? Response.json(namesPayload())
    if (path === ADMIN_BIND_PATH) return overrides.bind ?? Response.json(bindPayload())
    return new Response(null, { status: 404, headers: { 'Content-Type': 'application/json' } })
  })
}

/** 一个已校验的追加请求。 */
function request(overrides: Partial<BindRequestPayload> = {}): BindRequestPayload {
  return {
    publishedName: '千手·迅捷',
    backendKeys: ['pro', 'flash'],
    effectiveFrom: NOW + 48 * HOUR,
    reason: '把主后端换成更强的那个',
    rolloutPercent: 100,
    ...overrides,
  }
}

describe('目录读取', () => {
  it('用 POST 调管理路由，带同源凭据与 no-store，并把目录发布成快照', async () => {
    const fetch = transport(), controller = new RouteConsoleController(fetch)
    await controller.refresh()
    expect(String(fetch.mock.calls[0]?.[0])).toBe(ADMIN_NAMES_PATH)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' })
    expect(controller.store.getSnapshot()).toMatchObject({ catalog: catalog(), loading: false, readError: null })
    controller.dispose()
  })

  it('401 说「未登录或登录已失效」，不是网络错误，且不保留过期目录', async () => {
    const fetch = transport(), controller = new RouteConsoleController(fetch)
    await controller.refresh()
    fetch.mockImplementation(async (input) => String(input) === ADMIN_NAMES_PATH
      ? Response.json({ ok: false, message: '请先登录。' }, { status: 401 })
      : Response.json(bindPayload()))
    await controller.refresh()
    expect(controller.store.getSnapshot().readError).toEqual({ kind: 'not-signed-in', message: '请先登录。', key: 'notSignedIn' })
    expect(controller.store.getSnapshot().catalog).toBeNull()
    controller.dispose()
  })

  it('403 说「需要管理员权限」，这是降级呈现而不是错误页', async () => {
    const fetch = transport({ names: Response.json({ ok: false, message: '这个操作需要管理员权限。' }, { status: 403 }) })
    const controller = new RouteConsoleController(fetch)
    await controller.refresh()
    expect(controller.store.getSnapshot().readError).toEqual({ kind: 'forbidden', message: '这个操作需要管理员权限。', key: 'forbidden' })
    expect(controller.store.getSnapshot().loading).toBe(false)
    controller.dispose()
  })

  it('响应结构不认识时给「数据不完整」，不把半截数据当目录', async () => {
    const fetch = transport({ names: Response.json({ ok: true, names: [{ publishedName: '千手·迅捷' }], backends: [] }) })
    const controller = new RouteConsoleController(fetch)
    await controller.refresh()
    expect(controller.store.getSnapshot().catalog).toBeNull()
    expect(controller.store.getSnapshot().readError).toMatchObject({ kind: INVALID_ROUTE_RESPONSE, key: 'invalidResponse' })
    controller.dispose()
  })

  it('非 JSON 的失败响应退化成状态码，不抛异常出去', async () => {
    const fetch = transport({ names: new Response('<html>500</html>', { status: 500 }) })
    const controller = new RouteConsoleController(fetch)
    await controller.refresh()
    expect(controller.store.getSnapshot().readError).toEqual({ kind: 'request-failed', message: 'HTTP_500', key: 'requestFailed' })
    controller.dispose()
  })
})

describe('追加绑定', () => {
  it('把已校验的请求体发到绑定路由，成功后回读目录并发布追加后的历史', async () => {
    const fetch = transport(), controller = new RouteConsoleController(fetch)
    await controller.refresh()
    expect(await controller.bind(request())).toBe(true)
    const bind = fetch.mock.calls.find(([input]) => String(input) === ADMIN_BIND_PATH)
    expect(bind?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(JSON.parse(String(bind?.[1]?.body))).toEqual(request())
    expect(String(bind?.[1]?.body)).not.toContain('operator')
    expect(controller.store.getSnapshot().lastAppended?.history.map(binding => binding.effectiveFrom))
      .toEqual([NOW - 72 * HOUR, NOW - 24 * HOUR, NOW + 48 * HOUR])
    expect(controller.store.getSnapshot().bindError).toBeNull()
    controller.dispose()
  })

  it('服务端拒绝时原样带出中文原因（那是可行动的）', async () => {
    const message = '生效时刻必须晚于上一条绑定（2026-09-15T00:00:00.000Z）'
    const fetch = transport({ bind: Response.json({ ok: false, message }, { status: 400 }) })
    const controller = new RouteConsoleController(fetch)
    await controller.refresh()
    expect(await controller.bind(request({ effectiveFrom: NOW - HOUR }))).toBe(false)
    expect(controller.store.getSnapshot().bindError).toEqual({ kind: 'invalid', message, key: 'serverRejected' })
    expect(controller.store.getSnapshot().submitting).toBe(false)
    controller.dispose()
  })

  it('追加途中掉线也不伪装成功', async () => {
    const fetch = transport()
    fetch.mockImplementation(async (input) => {
      if (String(input) === ADMIN_BIND_PATH) throw new TypeError('Failed to fetch')
      return Response.json(namesPayload())
    })
    const controller = new RouteConsoleController(fetch)
    await controller.refresh()
    expect(await controller.bind(request())).toBe(false)
    expect(controller.store.getSnapshot().lastAppended).toBeNull()
    expect(controller.store.getSnapshot().bindError).toMatchObject({ kind: 'request-failed' })
    controller.dispose()
  })

  it('并发提交只放行一次（按钮之外的第二道闸门）', async () => {
    let release: ((value: Response) => void) | undefined
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const fetch = transport()
    fetch.mockImplementation(async (input) => {
      if (String(input) === ADMIN_BIND_PATH) return pending
      return Response.json(namesPayload())
    })
    const controller = new RouteConsoleController(fetch)
    await controller.refresh()
    const first = controller.bind(request())
    expect(await controller.bind(request())).toBe(false)
    release?.(Response.json(bindPayload()))
    expect(await first).toBe(true)
    expect(fetch.mock.calls.filter(([input]) => String(input) === ADMIN_BIND_PATH)).toHaveLength(1)
    controller.dispose()
  })

  it('卸载后不再发布任何状态', async () => {
    const fetch = transport(), controller = new RouteConsoleController(fetch)
    controller.dispose()
    await controller.refresh()
    expect(fetch).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().loading).toBe(true)
    expect(await controller.bind(request())).toBe(false)
  })

  it('appendFloor 给出同名字的上一条绑定时刻（没有绑定时为 null）', async () => {
    const fetch = transport(), controller = new RouteConsoleController(fetch)
    await controller.refresh()
    expect(controller.appendFloor('千手·迅捷')).toBe(activeBinding.effectiveFrom)
    expect(controller.appendFloor('不存在的名字')).toBeNull()
    controller.dispose()
  })
})
