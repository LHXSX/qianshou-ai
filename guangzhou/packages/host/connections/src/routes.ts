/** Authenticated browser operations; request bodies never include credential literals. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { connectionError } from './registry.ts'
import type { ConnectionsRegistry } from './registry.ts'
import { connectionId, idRequest } from './validation.ts'

/** Register bounded user-facing connection management routes.
 * @param ctx - Browser-authenticated Connection service.
 * @param registry - Host connection registry.
 */
export function registerRoutes(ctx: Context, registry: ConnectionsRegistry): void {
  const response = (body: unknown, status = 200) => Response.json(body, { status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
  const body = async (request: Request): Promise<unknown> => {
    const text = await request.text()
    if (text.length > 32_768) throw new Error('INVALID_CONNECTION')
    return JSON.parse(text)
  }
  const routes: Array<{ path: string; method: 'GET' | 'POST'; run(request: Request): unknown | Promise<unknown> }> = [
    { path: 'connections', method: 'GET', run: () => ({ connections: registry.list(), capabilities: { ssh: true, github: true, sshExecute: false } }) },
    { path: 'connections/save', method: 'POST', run: async request => registry.save(await body(request)) },
    { path: 'connections/delete', method: 'POST', run: async request => registry.delete(idRequest(await body(request))) },
    { path: 'connections/probe', method: 'POST', run: async request => registry.probe(idRequest(await body(request)), request.signal) },
    { path: 'connections/github-repos', method: 'GET', run: (request) => {
      const params = new URL(request.url).searchParams
      return registry.repositories(connectionId(params.get('id')), Number(params.get('page') ?? 1), request.signal)
    } },
  ]
  for (const route of routes) ctx.effect(() => ctx.connection.fetch.register({
    path: `/api/qianshou/${route.path}`, methods: [route.method], requestBody: 'buffered',
    fetch: async (request) => {
      try { return response(await route.run(request)) }
      catch (error) {
        const code = error instanceof Error && /^INVALID_CONNECTION(?:_ID|_PAGE|_STORE)?$/.test(error.message) ? error.message : connectionError(error)
        return response({ error: code }, code === 'CONNECTION_NOT_FOUND' ? 404 : code === 'CONNECTION_FORBIDDEN' ? 403 : code === 'CONNECTION_BUSY' ? 429 : 400)
      }
    },
  }), `connections: ${route.path}`)
}
