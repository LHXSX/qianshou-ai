/** Owner-authenticated local routes mounted on the existing Connection carrier. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ComputeService } from './service.ts'
import { ComputeError } from './errors.ts'
import { parseSupplyPolicy, SupplyError } from './supply/policy.ts'

/** Register bounded local planning, local supply and read-only core operations.
 * @param ctx - Existing authenticated Connection scope.
 * @param service - Plugin-owned store and network lifecycle.
 * @param maxRequestBytes - Additional local JSON limit under the carrier's transport limit.
 */
export function registerRoutes(ctx: Context, service: ComputeService, maxRequestBytes: number): void {
  const response = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
  const jsonBody = async (request: Request): Promise<unknown> => {
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ComputeError('COMPUTE_JSON_REQUIRED', 415)
    const text = await request.text()
    if (Buffer.byteLength(text) > maxRequestBytes) throw new ComputeError('COMPUTE_REQUEST_TOO_LARGE', 413)
    try { return JSON.parse(text) as unknown } catch { throw new ComputeError('INVALID_COMPUTE_JSON') }
  }
  const routes: Array<{ path: string; runs: Partial<Record<'GET' | 'POST', (request: Request) => unknown>> }> = [
    { path: 'status', runs: { GET: () => service.status() } },
    { path: 'capabilities', runs: { GET: request => service.capabilities(request.signal) } },
    { path: 'supply', runs: { GET: request => service.querySupplySnapshot(request.signal) } },
    { path: 'supply/policy', runs: { POST: async request => service.updateSupplyPolicy(parseSupplyPolicy(await jsonBody(request)), request.signal) } },
    { path: 'plans', runs: {
      GET: () => service.plans(),
      POST: async request => service.createPlan(await jsonBody(request), request.signal),
    } },
    { path: 'plans/confirm', runs: {
      POST: async request => service.confirmPlan(await jsonBody(request), request.signal),
    } },
    { path: 'plans/publish', runs: {
      POST: async request => service.publishPlan(await jsonBody(request), request.signal),
    } },
    { path: 'workload', runs: { GET: request => service.workload(new URL(request.url).searchParams.get('id') ?? '', request.signal) } },
  ]
  for (const route of routes) {
    const methods = Object.keys(route.runs) as Array<'GET' | 'POST'>
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/qianshou/compute/${route.path}`, methods, requestBody: 'buffered',
      fetch: async (request) => {
        const method = request.method as 'GET' | 'POST'
        const run = route.runs[method]
        if (!run) return response(null, 405)
        try { return response(await run(request), method === 'POST' && route.path === 'plans' ? 201 : 200) }
        catch (error) {
          if (error instanceof SupplyError) return response({ error: { code: error.code, message: error.code } }, error.code === 'SUPPLY_POLICY_INVALID' ? 400 : 503)
          const failure = error instanceof ComputeError ? error : error instanceof TypeError && error.message.startsWith('INVALID_COMPUTE_') ? new ComputeError('INVALID_COMPUTE_REQUEST') : new ComputeError('COMPUTE_REQUEST_FAILED', 502)
          return response({ error: { code: failure.code, message: failure.code } }, failure.status)
        }
      },
    }), `compute: ${methods.join('/')} ${route.path}`)
  }
}
