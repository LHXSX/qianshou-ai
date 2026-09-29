import { updateWorkOf } from '@deepseek-ai/dsh-agent'
/** Owner-authenticated routes for the separately enabled, unbilled H3 trial. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ComputeError } from './errors.ts'
import type { ImageTrialHost } from './image-trial.ts'
import { VideoTrialHost, type VideoTrialConfig } from './video-trial.ts'

const PREFIX = '/api/qianshou/compute/video-trial/'
const MAX_REQUEST = Math.ceil(16 * 1024 * 1024 / 3) * 4 + 16384
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }

/** Mount local owner routes; share the existing image Host for optional first-frame generation.
 * @param ctx - Existing authenticated owner Connection.
 * @param config - Operator-owned loopback configuration, absent by default.
 * @param directory - Absolute private input, receipt and result directory.
 * @param limits - Deployment-owned receipt storage limits.
 * @param images - Existing image Host; no second image slot is created.
 */
export function registerVideoTrialRoutes(ctx: Context, config: VideoTrialConfig | undefined, directory: string,
  limits: { maxRecords: number; maxStoreBytes: number }, images: ImageTrialHost): void {
  const host = new VideoTrialHost(config, directory, limits, images)
  ctx.effect(() => updateWorkOf(ctx.root).register({ setLocked: locked => host.setUpdateLocked(locked),
    inspect: () => host.updateState() }), 'compute: update trial protection')
  const sessionExists = (id: string): boolean => ctx.get('agents')?.get(id as SessionId) !== undefined
    || ctx.get('sessions')?.get(id as SessionId) !== undefined
  const locator = async (request: Request, allowRetry = false): Promise<{ id: string; sessionId: string; retryDelivery: boolean }> => {
    const query = new URL(request.url).searchParams
    const id = query.get('id') ?? ''
    const sessionId = query.get('sessionId') ?? ''
    const retryDelivery = allowRetry && query.get('retryDelivery') === '1'
    if (query.size !== (retryDelivery ? 3 : 2) || query.getAll('id').length !== 1 || query.getAll('sessionId').length !== 1
      || !/^[A-Za-z0-9._:-]{1,128}$/u.test(sessionId)) throw new ComputeError('VIDEO_TRIAL_SESSION_UNAVAILABLE', 403)
    if (!sessionExists(sessionId)) {
      const stored = await ctx.get('sessionPersistence')?.stat(sessionId as SessionId, { signal: request.signal })
      if (stored?.header.id !== sessionId) throw new ComputeError('VIDEO_TRIAL_SESSION_UNAVAILABLE', 403)
    }
    return { id, sessionId, retryDelivery }
  }
  const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers })
  const routes: Array<{ path: string; method: 'GET' | 'POST'; run: (request: Request) => Promise<Response> | Response }> = [
    { path: 'status', method: 'GET', run: () => json(host.status()) },
    { path: 'jobs', method: 'POST', run: async (request) => {
      if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        throw new ComputeError('VIDEO_TRIAL_JSON_REQUIRED', 415)
      }
      const reader = request.body?.getReader()
      if (reader === undefined) throw new ComputeError('VIDEO_TRIAL_INVALID', 400)
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > MAX_REQUEST) throw new ComputeError('VIDEO_TRIAL_REQUEST_TOO_LARGE', 413)
          chunks.push(part.value)
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
      let value: unknown
      try { value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown }
      catch { throw new ComputeError('VIDEO_TRIAL_INVALID', 400) }
      return json(await host.submit(value, sessionExists), 202)
    } },
    { path: 'job', method: 'GET', run: async (request) => {
      const { id, sessionId, retryDelivery } = await locator(request, true)
      return json(await host.job(id, sessionId, retryDelivery))
    } },
    { path: 'video', method: 'GET', run: async (request) => {
      const { id, sessionId } = await locator(request)
      return new Response(new Uint8Array(await host.video(id, sessionId)), { headers: { ...headers,
        'Content-Type': 'video/mp4', 'Content-Disposition': 'inline; filename="qianshou-video.mp4"' } })
    } },
  ]
  ctx.effect(() => () => host.close(), 'compute: settle private video trial')
  for (const route of routes) ctx.effect(() => ctx.connection.fetch.register({
    path: PREFIX + route.path, methods: [route.method], requestBody: 'buffered',
    fetch: async (request) => {
      try { return await route.run(request) }
      catch (error) {
        const failure = error instanceof ComputeError ? error : new ComputeError('VIDEO_TRIAL_REQUEST_FAILED', 502)
        return json({ error: { code: failure.code, message: failure.code } }, failure.status)
      }
    },
  }), `compute: video trial ${route.path}`)
}
