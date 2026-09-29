/** Local authenticated media controls; quote and viewer credentials remain on the Host. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ComputeError } from './errors.ts'
import { FormalMediaControl } from './formal-media-control.ts'
import { formalMediaObject } from './formal-media-protocol.ts'

/** Register formal media controls on the existing Connection carrier.
 * @param ctx - Authenticated local scope.
 * @param control - Plugin-owned media request lifetime.
 * @param maxRequestBytes - Deployment-selected local JSON limit.
 */
export function registerFormalMediaRoutes(ctx: Context, control: FormalMediaControl, maxRequestBytes: number): void {
  const response = (value: unknown, status = 200) => Response.json(value, { status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
  const body = async (request: Request, limit = maxRequestBytes): Promise<unknown> => {
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new ComputeError('COMPUTE_JSON_REQUIRED', 415)
    const reader = request.body?.getReader()
    if (reader === undefined) throw new ComputeError('INVALID_COMPUTE_JSON', 400)
    const chunks: Buffer[] = []
    let size = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > limit) throw new ComputeError('COMPUTE_REQUEST_TOO_LARGE', 413)
        chunks.push(Buffer.from(part.value))
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    const raw = Buffer.concat(chunks, size).toString('utf8')
    try { return JSON.parse(raw) as unknown } catch { throw new ComputeError('INVALID_COMPUTE_JSON', 400) }
  }
  const requireSession = async (value: unknown, request: Request, cold: boolean) => {
    const row = formalMediaObject(value)
    if (typeof row.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(row.sessionId)) throw new ComputeError('COMPUTE_MEDIA_SESSION_UNAVAILABLE', 403)
    const id = row.sessionId as SessionId
    if (ctx.get('agents')?.get(id) === undefined && ctx.get('sessions')?.get(id) === undefined) {
      const stored = cold ? await ctx.get('sessionPersistence')?.stat(id, { signal: request.signal }) : undefined
      if (stored?.header.id !== id) throw new ComputeError('COMPUTE_MEDIA_SESSION_UNAVAILABLE', 403)
    }
    return value
  }
  const definitions = [
    { name: 'profiles', method: 'GET', run: (request: Request) => control.directory(request.signal) },
    { name: 'quote', method: 'POST', run: async (request: Request) => control.quote(await requireSession(await body(request), request, false), request.signal) },
    { name: 'confirm', method: 'POST', run: async (request: Request) => control.confirm(await requireSession(await body(request), request, false), request.signal) },
    { name: 'asset-upload', method: 'POST', run: async (request: Request) => control.uploadAsset(
      await requireSession(await body(request, Math.ceil(16777216 / 3) * 4 + 4096), request, false), request.signal) },
    { name: 'asset-status', method: 'POST', run: async (request: Request) => control.assetStatus(
      await requireSession(await body(request), request, true), request.signal) },
    { name: 'state', method: 'GET', run: async (request: Request) => {
      const params = new URL(request.url).searchParams
      if (params.size !== 2 || params.getAll('requestId').length !== 1 || params.getAll('sessionId').length !== 1) throw new ComputeError('COMPUTE_MEDIA_INVALID', 400)
      return control.state(await requireSession({ requestId: params.get('requestId'), sessionId: params.get('sessionId') }, request, true), request.signal)
    } },
  ] as const
  for (const route of definitions) ctx.effect(() => ctx.connection.fetch.register({
    path: `/api/qianshou/compute/media/${route.name}`, methods: [route.method], requestBody: 'buffered',
    fetch: async (request) => {
      try { return response(await route.run(request)) }
      catch (error) {
        const failure = error instanceof ComputeError ? error : new ComputeError('COMPUTE_MEDIA_UNAVAILABLE', 502)
        return response({ error: { code: failure.code } }, failure.status)
      }
    },
  }), `formal media: ${route.method} ${route.name}`)
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/compute/media/result', methods: ['GET'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const params = new URL(request.url).searchParams
        if (params.size !== 2 || params.getAll('requestId').length !== 1 || params.getAll('sessionId').length !== 1) throw new ComputeError('COMPUTE_MEDIA_INVALID', 400)
        const value = await requireSession({ requestId: params.get('requestId'), sessionId: params.get('sessionId') }, request, true)
        const result = await control.media(value, request.signal)
        return new Response(new Uint8Array(result.bytes), { headers: { 'Cache-Control': 'private, no-store',
          'Content-Type': result.contentType, 'Content-Length': String(result.bytes.length), 'X-Content-Type-Options': 'nosniff',
          'X-Qianshou-Sha256': result.sha256 } })
      } catch (error) {
        const failure = error instanceof ComputeError ? error : new ComputeError('COMPUTE_MEDIA_DELIVERY_UNAVAILABLE', 502)
        return response({ error: { code: failure.code } }, failure.status)
      }
    },
  }), 'formal media: settled Guangzhou delivery')
}
