import { createServer, type Server, type RequestListener } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { parseQuery, registryUrl, searchRegistry } from '../src/registry.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => { resolve() })
  })))
})
async function start(handler: RequestListener): Promise<URL> {
  const server = createServer(handler); servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); if (typeof address !== 'object' || !address) throw new Error('listen failed')
  return registryUrl(`http://127.0.0.1:${address.port}/`)
}
describe('metadata discovery over real HTTP', () => {
  it('checks exact manifests, excludes non-bundles, counts failures and sends no credentials', async () => {
    const requests: string[] = []
    const source = await start((request, response) => {
      expect(request.headers.authorization).toBeUndefined(); expect(request.headers.cookie).toBeUndefined()
      const url = new URL(request.url!, 'http://local'); requests.push(url.pathname)
      response.setHeader('content-type', 'application/json')
      if (url.pathname === '/-/v1/search') {
        expect(url.searchParams.get('text')).toBe('keywords:dsh-plugin writer')
        response.end(JSON.stringify({ total: 30, objects: ['@fixture/writer', 'plain', 'missing'].map(name => ({ package: { name, version: '1.2.3' } })) }))
      } else if (url.pathname.includes('writer')) response.end(JSON.stringify({ name: '@fixture/writer', version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } }, _npmUser: { name: 'writer', email: 'not-returned' }, homepage: 'javascript:alert(1)', description: 'Writes text', license: 'MIT' }))
      else if (url.pathname.includes('plain')) response.end(JSON.stringify({ name: 'plain', version: '1.2.3' }))
      else { response.statusCode = 503; response.end('private diagnostic') }
    })
    const result = await searchRegistry(source, parseQuery({ query: 'writer', offset: 0 }), new AbortController().signal)
    expect(requests).toHaveLength(4)
    expect(result).toMatchObject({ candidates: 3, excluded: 1, unavailable: 1, nextOffset: 12 })
    expect(result.entries).toEqual([{ name: '@fixture/writer', version: '1.2.3', description: 'Writes text', publisher: 'writer', license: 'MIT', homepage: null,
      packageUrl: new URL('%40fixture%2Fwriter/1.2.3', source).href, installSpec: '@fixture/writer@1.2.3' }])
    expect(JSON.stringify(result)).not.toContain('not-returned')
  })
  it('rejects malformed search bodies and oversized bodies instead of reporting an empty market', async () => {
    let large = false
    const source = await start((_request, response) => { response.end(large ? ' '.repeat(1024 * 1024 + 1) : JSON.stringify({ objects: [], total: -1 })) })
    await expect(searchRegistry(source, { query: '', offset: 0 }, new AbortController().signal)).rejects.toThrow('invalid-response')
    large = true
    await expect(searchRegistry(source, { query: '', offset: 0 }, new AbortController().signal)).rejects.toThrow('invalid-response')
  })
  it('refuses redirects and wrong package/version identity', async () => {
    let redirect = true
    const source = await start((request, response) => {
      if (redirect) { response.statusCode = 302; response.setHeader('Location', '/secret'); response.end(); return }
      response.end(JSON.stringify(request.url!.startsWith('/-/v1/search') ? { total: 1, objects: [{ package: { name: 'writer', version: '1.0.0' } }] } : { name: 'other', version: '1.0.0', dsh: { bundle: { patch: 'x' } } }))
    })
    await expect(searchRegistry(source, { query: '', offset: 0 }, new AbortController().signal)).rejects.toThrow()
    redirect = false
    expect(await searchRegistry(source, { query: '', offset: 0 }, new AbortController().signal)).toMatchObject({ entries: [], unavailable: 1 })
  })
  it('observes cancellation during metadata reads', async () => {
    const abort = new AbortController()
    const source = await start((_request, _response) => { abort.abort() })
    await expect(searchRegistry(source, { query: '', offset: 0 }, abort.signal)).rejects.toThrow()
  })
  it('validates destinations, inputs and offsets before network activity', () => {
    for (const source of ['http://example.com', 'https://u:p@registry.npmjs.org', 'https://registry.npmjs.org/?token=x']) expect(() => registryUrl(source)).toThrow()
    for (const query of [{ query: 'author:someone', offset: 0 }, { query: 'a'.repeat(121), offset: 0 }, { query: '', offset: 1 }, { query: '', offset: 1212 }]) expect(() => parseQuery(query)).toThrow('invalid-query')
    expect(parseQuery({ query: '  中文搜索  ', offset: 12 })).toEqual({ query: '中文搜索', offset: 12 })
  })
})
