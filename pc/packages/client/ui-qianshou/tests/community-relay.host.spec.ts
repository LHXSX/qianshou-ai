import { describe, expect, it, vi } from 'vitest'
import { communityOrigin, communityRoutes } from '../src/relay/community-relay.ts'

function route(fetchImpl: typeof fetch, token: string | null = 'host-only-token') {
  const session = { ensureAccessToken: vi.fn(async () => token) }
  const routes = communityRoutes(session, { origin: 'https://forum.example.test', fetchImpl })
  const topics = routes.find(item => item.path.endsWith('/topics'))!
  return { session, topics, routes }
}

function incoming(payload: unknown, contentType = 'application/json'): Request {
  return new Request('http://127.0.0.1/api/qianshou/community/topics', {
    method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify(payload),
  })
}

describe('desktop community relay', () => {
  it('uses only fixed authenticated routes and keeps the bearer in the Host', async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, items: [], nextCursor: null }), {
      headers: { 'content-type': 'application/json' },
    }))
    const { topics, routes } = route(upstream)
    expect(routes.map(item => item.path)).toEqual([
      '/api/qianshou/community/categories', '/api/qianshou/community/topics', '/api/qianshou/community/topic',
      '/api/qianshou/community/topic/create', '/api/qianshou/community/reply/create',
      '/api/qianshou/community/topic/solve', '/api/qianshou/community/report',
    ])
    expect(routes.every(item => item.requestBody === 'streaming')).toBe(true)
    const response = await topics.fetch(incoming({ category: 'help' }))
    expect(await response.json()).toEqual({ ok: true, items: [], nextCursor: null })
    const [url, init] = upstream.mock.calls[0]!
    expect(String(url)).toBe('https://forum.example.test/api/qianshou/community/topics')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer host-only-token')
    expect(await new Request(url, init).text()).toBe(JSON.stringify({ category: 'help' }))
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses missing account, oversized requests, invalid JSON, and remote-origin configuration', async () => {
    const upstream = vi.fn<typeof fetch>()
    const withoutAccount = route(upstream, null)
    expect((await withoutAccount.topics.fetch(incoming({}))).status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
    const { topics } = route(upstream)
    expect((await topics.fetch(incoming({ body: 'x'.repeat(70_000) }))).status).toBe(413)
    expect((await topics.fetch(incoming({}, 'text/plain'))).status).toBe(415)
    expect(upstream).not.toHaveBeenCalled()
    expect(() => communityOrigin('http://example.test')).toThrow()
    expect(() => communityOrigin('https://admin.example.test/other')).toThrow()
  })

  it('returns an explicit failure when Guangzhou is unreachable or sends malformed JSON', async () => {
    const unreachable = route(vi.fn<typeof fetch>(async () => { throw new Error('private network detail') }))
    const failed = await unreachable.topics.fetch(incoming({}))
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ ok: false, code: 'FORUM_UPSTREAM_UNAVAILABLE' })
    const malformed = route(vi.fn<typeof fetch>(async () => new Response('<html>error</html>')))
    const invalid = await malformed.topics.fetch(incoming({}))
    expect(invalid.status).toBe(502)
    expect(await invalid.json()).toEqual({ ok: false, code: 'FORUM_UPSTREAM_INVALID' })
    const missingLiveRoute = route(vi.fn<typeof fetch>(async () => new Response('<html>Admin app</html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })))
    const pending = await missingLiveRoute.topics.fetch(incoming({}))
    expect(pending.status).toBe(503)
    expect(await pending.json()).toEqual({ ok: false, code: 'FORUM_NOT_LIVE' })
  })
})
