import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import QianshouPluginCatalog from '../src/index.ts'

it('bounds concurrent searches and awaits cancellation of real HTTP requests during disposal', async () => {
  const server = createServer((_request, _response) => {})
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('listen failed')
  const ctx = new Context()
  try {
    const fiber = ctx.plugin(QianshouPluginCatalog, {
      registryUrl: `http://127.0.0.1:${address.port}/`, timeoutMs: 10000,
      connection: 'shipped', apiBaseUrl: '', installHome: '', publisherKeys: {},
    })
    await fiber
    const service = ctx.qianshouPluginCatalog
    const first = service.search({ query: 'one', offset: 0 }).catch((error: unknown) => error)
    const second = service.search({ query: 'two', offset: 0 }).catch((error: unknown) => error)
    await expect(service.search({ query: 'three', offset: 0 })).rejects.toThrow('_busy')
    await fiber.dispose()
    expect(await first).toBeInstanceOf(Error); expect(await second).toBeInstanceOf(Error)
    await expect(service.search({ query: '', offset: 0 })).rejects.toThrow('_closed')
  } finally {
    await ctx.fiber.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
})
