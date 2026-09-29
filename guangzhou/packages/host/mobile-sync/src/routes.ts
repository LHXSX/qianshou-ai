/** Owner-authenticated mobile sync routes mounted on the existing Connection carrier. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { MobileSyncError } from './errors.ts'
import type { MobileSyncService } from './service.ts'

/** Register the bounded mobile sync surface.
 *
 * The route path sits below `/api`, so the carrier has already applied its Host
 * fence and browser authentication before this handler runs; the handler never
 * re-implements authentication and never accepts a non-loopback Host by itself.
 * @param ctx - Existing authenticated Connection scope.
 * @param service - Plugin-owned durable cursor and revision state.
 * @param maxRequestBytes - Additional local JSON limit under the carrier's transport limit.
 */
export function registerRoutes(ctx: Context, service: MobileSyncService, maxRequestBytes: number): void {
  const response = (value: unknown, status = 200): Response => Response.json(value, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  })
  const body = async (request: Request): Promise<Record<string, unknown>> => {
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new MobileSyncError('MOBILE_SYNC_JSON_REQUIRED', 415)
    const text = await request.text()
    if (Buffer.byteLength(text) > maxRequestBytes) throw new MobileSyncError('MOBILE_SYNC_REQUEST_TOO_LARGE', 413)
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new MobileSyncError('MOBILE_SYNC_REQUEST_INVALID') }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new MobileSyncError('MOBILE_SYNC_REQUEST_INVALID')
    return parsed as Record<string, unknown>
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/mobile/sync', methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const payload = await body(request)
        const result = await service.sync(payload.request, payload.heartbeat)
        // The acknowledgement stays at the top level so the client parses the same
        // shape its transport contract declares; `outcome` rides along as diagnostics.
        return response({ ...result.ack, outcome: result.outcome })
      } catch (error) {
        const failure = error instanceof MobileSyncError ? error : new MobileSyncError('MOBILE_SYNC_FAILED', 502)
        return response({ error: { code: failure.code, message: failure.code } }, failure.status)
      }
    },
  }), 'mobile-sync: POST /api/qianshou/mobile/sync')
}
