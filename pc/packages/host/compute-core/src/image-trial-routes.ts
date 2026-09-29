import { updateWorkOf } from '@deepseek-ai/dsh-agent'
/** Owner-authenticated HTTP access to explicitly configured, non-billable Guangzhou image trials. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ComputeError } from './errors.ts'
import { ImageTrialHost, type ImageTrialConfig } from './image-trial.ts'
import { ResearchImageHost } from './research-image.ts'

const PREFIX = '/api/qianshou/compute/image-trial/'
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }

/** Mount reversible owner routes; credentials stay in the Host and media never traverse Shanghai.
 * @param ctx - Existing owner-authenticated Connection scope.
 * @param config - Optional operator configuration; absence leaves the feature disabled.
 * @param directory - Absolute owner-private receipt and image directory.
 * @param limits - Existing deployment-owned store limits.
 * @returns The same Host instance for an explicit video first-frame child.
 */
export function registerImageTrialRoutes(ctx: Context, config: ImageTrialConfig | undefined, directory: string,
  limits: { maxRecords: number; maxStoreBytes: number }, research?: ResearchImageHost): ImageTrialHost {
  const host = new ImageTrialHost(config, directory, limits)
  ctx.effect(() => updateWorkOf(ctx.root).register({ setLocked: locked => host.setUpdateLocked(locked),
    inspect: () => host.updateState() }), 'compute: update trial protection')
  const sessionExists = (id: string): boolean => ctx.get('agents')?.get(id as SessionId) !== undefined
    || ctx.get('sessions')?.get(id as SessionId) !== undefined
  const locator = async (request: Request): Promise<{ id: string; sessionId: string }> => {
    const query = new URL(request.url).searchParams
    const id = query.get('id') ?? ''
    const sessionId = query.get('sessionId') ?? ''
    if (query.size !== 2 || !/^[A-Za-z0-9._:-]{1,128}$/u.test(sessionId)) {
      throw new ComputeError('IMAGE_TRIAL_SESSION_UNAVAILABLE', 403)
    }
    // A retained image can outlive its in-memory Agent. Observe its stored identity
    // without restoring an Agent, acquiring a write handle, or authorizing a new job.
    if (!sessionExists(sessionId)) {
      const stored = await ctx.get('sessionPersistence')?.stat(sessionId as SessionId, { signal: request.signal })
      if (stored?.header.id !== sessionId) throw new ComputeError('IMAGE_TRIAL_SESSION_UNAVAILABLE', 403)
    }
    return { id, sessionId }
  }
  const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers })
  const routes: Array<{ path: string; method: 'GET' | 'POST'; run: (request: Request) => Promise<Response> | Response }> = [
    { path: 'status', method: 'GET', run: () => {
      const privateStatus = host.status()
      return json(privateStatus.enabled || research?.enabled() !== true ? privateStatus
        : { enabled: true, sizes: ['landscape'], steps: 8, supportedSteps: [8], billing: 'research-no-charge' })
    } },
    { path: 'jobs', method: 'POST', run: async (request) => {
      if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        throw new ComputeError('IMAGE_TRIAL_JSON_REQUIRED', 415)
      }
      const text = await request.text()
      if (Buffer.byteLength(text) > 16384) throw new ComputeError('IMAGE_TRIAL_REQUEST_TOO_LARGE', 413)
      let value: unknown
      try { value = JSON.parse(text) as unknown } catch { throw new ComputeError('IMAGE_TRIAL_INVALID', 400) }
      const body = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
      const id = typeof body?.id === 'string' ? body.id : ''
      // Original ledgers take precedence over today's routing. An uncertain pool POST never falls back.
      if (id && await host.owns(id)) return json(await host.submit(value, sessionExists), 202)
      if (research !== undefined && ((id && await research.owns(id))
        || (research.enabled() && body?.size === 'landscape' && (body.steps === undefined || body.steps === 8)))) {
        return json(await research.submit(value, sessionExists), 202)
      }
      return json(await host.submit(value, sessionExists), 202)
    } },
    { path: 'job', method: 'GET', run: async (request) => {
      const { id, sessionId } = await locator(request)
      return json(await (research !== undefined && await research.owns(id) ? research : host).job(id, sessionId))
    } },
    { path: 'image', method: 'GET', run: async (request) => {
      const { id, sessionId } = await locator(request)
      const selected = research !== undefined && await research.owns(id) ? research : host
      return new Response(new Uint8Array(await selected.image(id, sessionId)), { headers: { ...headers,
        'Content-Type': 'image/png', 'Content-Disposition': 'inline; filename="qianshou-image.png"' } })
    } },
  ]
  ctx.effect(() => () => host.close(), 'compute: settle private image trial')
  for (const route of routes) ctx.effect(() => ctx.connection.fetch.register({
    path: PREFIX + route.path, methods: [route.method], requestBody: 'buffered',
    fetch: async (request) => {
      try { return await route.run(request) }
      catch (error) {
        const failure = error instanceof ComputeError ? error : new ComputeError('IMAGE_TRIAL_REQUEST_FAILED', 502)
        return json({ error: { code: failure.code, message: failure.code } }, failure.status)
      }
    },
  }), `compute: image trial ${route.path}`)
  return host
}
