/** Owner-authenticated local routes mounted on the existing Connection carrier. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ComputeService } from './service.ts'
import { ComputeError } from './errors.ts'
import { parseSupplyPolicy, SupplyError } from './supply/policy.ts'
import type { GuangzhouAccountState } from './natural-intent-route.ts'
import { MAX_PLAN_INPUT_BYTES } from './plan-file-input.ts'
import { importMarketAttachments } from './market-attachment-import.ts'

/** Register bounded local planning, local supply and read-only core operations.
 * @param ctx - Existing authenticated Connection scope.
 * @param service - Plugin-owned store and network lifecycle.
 * @param maxRequestBytes - Additional local JSON limit under the carrier's transport limit.
 */
export function registerRoutes(ctx: Context, service: ComputeService, maxRequestBytes: number): void {
  const response = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
  const jsonBody = async (request: Request, limit = maxRequestBytes): Promise<unknown> => {
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ComputeError('COMPUTE_JSON_REQUIRED', 415)
    const text = await request.text()
    if (Buffer.byteLength(text) > limit) throw new ComputeError('COMPUTE_REQUEST_TOO_LARGE', 413)
    try { return JSON.parse(text) as unknown } catch { throw new ComputeError('INVALID_COMPUTE_JSON') }
  }
  const routes: Array<{ path: string; runs: Partial<Record<'GET' | 'POST', (request: Request) => unknown>> }> = [
    { path: 'status', runs: { GET: () => service.status() } },
    { path: 'capabilities', runs: { GET: request => service.capabilities(request.signal) } },
    { path: 'task-types', runs: { GET: request => service.taskTypes(request.signal) } },
    { path: 'natural-intent/preview', runs: {
      POST: async request => service.previewNaturalIntent(await jsonBody(request), await guangzhouAccountState(ctx), request.signal),
    } },
    { path: 'node/dashboard', runs: { GET: (request) => {
      const params = new URL(request.url).searchParams
      return service.nodeDashboard(params.get('worker_id') ?? '', Number(params.get('offset') ?? '0'), request.signal)
    } } },
    { path: 'supply', runs: { GET: request => service.querySupplySnapshot(request.signal) } },
    { path: 'supply/policy', runs: { POST: async request => service.updateSupplyPolicy(parseSupplyPolicy(await jsonBody(request)), request.signal) } },
    { path: 'plans', runs: {
      GET: () => service.plans(),
      POST: async request => service.createPlan(await jsonBody(request), request.signal),
    } },
    { path: 'plugin-drafts', runs: {
      GET: () => service.localPluginDrafts(),
      POST: async request => service.saveLocalPluginDraft(await jsonBody(request)),
    } },
    { path: 'video-workflow-drafts', runs: {
      GET: () => service.localVideoWorkflowDrafts(),
      POST: async request => service.saveLocalVideoWorkflowDraft(await jsonBody(request, 512 * 1024)),
    } },
    { path: 'plugin-drafts/export', runs: {
      GET: request => service.exportLocalPluginDraft(new URL(request.url).searchParams.get('id')),
    } },
    { path: 'plugin-drafts/preview', runs: {
      GET: request => service.previewLocalPluginDraft(new URL(request.url).searchParams.get('id')),
    } },
    { path: 'plugin-drafts/reviewable-execution/export', runs: {
      GET: request => service.exportReviewableExecutionCandidate(
        new URL(request.url).searchParams.get('sha256') ?? ''),
    } },
    { path: 'plugin-drafts/comfy-trials', runs: {
      GET: () => service.recentLocalPluginComfyTrials(),
    } },
    { path: 'plugin-drafts/comfy-trials/reconcile', runs: {
      POST: async (request) => {
        const body = await jsonBody(request)
        if (body === null || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== 1 || typeof (body as { id?: unknown }).id !== 'string') {
          throw new ComputeError('COMPUTE_COMFY_TRIAL_INVALID', 400)
        }
        return service.reconcileLocalPluginComfyTrial((body as { id: string }).id, request.signal)
      },
    } },
    { path: 'plans/confirm', runs: {
      POST: async request => service.confirmPlan(await jsonBody(request), request.signal),
    } },
    { path: 'plans/quote', runs: {
      POST: async request => service.quotePlan(await jsonBody(request), request.signal),
    } },
    // The client calls this only after displaying the exact Shanghai quote and
    // receiving a fresh owner click. There is deliberately no model tool for it.
    // The Service rechecks its private quote ticket, amount, expiry, account and
    // durable submission ledger; a forged body cannot bypass those checks.
    { path: 'plans/confirm-quoted', runs: {
      POST: async request => service.confirmQuotedPlan(await jsonBody(request), request.signal),
    } },
    { path: 'plans/publish', runs: {
      POST: async request => service.publishPlan(await jsonBody(request), request.signal),
    } },
    { path: 'chains/confirm', runs: {
      POST: async request => service.confirmChain(await jsonBody(request), request.signal),
    } },
    { path: 'chains/absence', runs: {
      POST: async request => service.applyChainAbsence(await jsonBody(request), request.signal),
    } },
    { path: 'chains/expand', runs: {
      POST: async request => service.expandChain(await jsonBody(request), request.signal),
    } },
    { path: 'workload', runs: { GET: request => service.workload(new URL(request.url).searchParams.get('id') ?? '', request.signal) } },
    { path: 'workload/result', runs: { GET: request => service.workloadResult(new URL(request.url).searchParams.get('id') ?? '', request.signal) } },
    { path: 'workload/acceptance', runs: {
      GET: request => service.workloadAcceptance(new URL(request.url).searchParams.get('id') ?? '', request.signal),
      POST: async (request) => {
        const body = acceptanceBody(await jsonBody(request))
        return service.decideWorkloadAcceptance(body.id, body.decision, body.idempotencyKey, request.signal)
      },
    } },
    // Cancelling mutates an existing workload, so it takes a JSON body like the other two POST
    // routes (there was no entry at all before: four plausible paths answered 404 — AT-03).
    { path: 'workload/cancel', runs: {
      POST: async request => service.cancelWorkload(workloadIdFromBody(await jsonBody(request)), request.signal),
    } },
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
  // The authenticated local PC receives the bytes. Core upload/complete requests carry metadata.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/compute/files/upload', methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const rawName = request.headers.get('x-qianshou-filename')
        if (rawName === null || rawName.length > 1536) throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 400)
        const filename = decodeURIComponent(rawName)
        const length = request.headers.get('content-length')
        if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_PLAN_INPUT_BYTES)) {
          throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 413)
        }
        const reader = request.body?.getReader()
        if (!reader) throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 400)
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            request.signal.throwIfAborted()
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.length
            if (size > MAX_PLAN_INPUT_BYTES) throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 413)
            chunks.push(chunk.value)
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
        const purpose = request.headers.get('x-qianshou-upload-purpose')
        if (purpose !== null && purpose !== 'reviewed-video-first-frame') {
          throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 400)
        }
        return response(await service.uploadInputFile({ filename,
          contentType: request.headers.get('content-type') ?? 'application/octet-stream', bytes },
        request.signal, purpose ?? undefined))
      } catch (error) {
        const failure = error instanceof ComputeError ? error : new ComputeError('COMPUTE_INPUT_UPLOAD_FAILED', 502)
        return response({ error: { code: failure.code, message: failure.code } }, failure.status)
      }
    },
  }), 'compute: upload owned task input')
  ctx.inject(['agents', 'fileUploads', 'attachments'], scope => scope.effect(() => scope.connection.fetch.register({
    path: '/api/qianshou/compute/files/from-composer', methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const text = await request.text()
        if (Buffer.byteLength(text) > Math.ceil(MAX_PLAN_INPUT_BYTES / 3) * 4 + 4096) {
          throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 413)
        }
        const body: unknown = JSON.parse(text)
        if (body === null || typeof body !== 'object' || Array.isArray(body)
          || !('sessionId' in body) || typeof body.sessionId !== 'string') {
          throw new ComputeError('COMPUTE_INPUT_RECEIPT_INVALID', 409)
        }
        const agent = scope.agents.get(body.sessionId as SessionId)
        if (agent === undefined) throw new ComputeError('COMPUTE_INPUT_RECEIPT_INVALID', 409)
        const files = await importMarketAttachments('attachments' in body ? body.attachments : undefined, {
          resolve: receiptId => scope.fileUploads.resolve(agent, receiptId as FileUploadReceiptId),
          read: (file, signal) => scope.attachments.readFileStream(file, signal),
          upload: (input, signal) => service.uploadInputFile(input, signal),
        }, request.signal)
        if (scope.agents.get(agent.id) !== agent) throw new ComputeError('COMPUTE_INPUT_RECEIPT_INVALID', 409)
        return response(files)
      } catch (error) {
        const failure = error instanceof ComputeError ? error : new ComputeError('COMPUTE_INPUT_UPLOAD_FAILED', 502)
        return response({ error: { code: failure.code, message: failure.code } }, failure.status)
      }
    },
  }), 'compute: import addressed composer receipts'))
  // The Connection carrier authenticates the local owner. Only an opaque, completed trial ID
  // reaches this image route; the Host resolves and rehashes its owner-only file internally.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/compute/plugin-drafts/comfy-trials/image', methods: ['GET'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const params = new URL(request.url).searchParams
        if (params.size !== 1) throw new ComputeError('COMPUTE_COMFY_TRIAL_INVALID', 400)
        const id = params.get('id')
        if (id === null) throw new ComputeError('COMPUTE_COMFY_TRIAL_INVALID', 400)
        const bytes = await service.readLocalPluginComfyTrialImage(id)
        return new Response(new Uint8Array(bytes), { headers: {
          'Content-Type': 'image/png', 'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="qianshou-sample.png"',
        } })
      } catch (error) {
        const failure = error instanceof ComputeError ? error : new ComputeError('COMPUTE_REQUEST_FAILED', 502)
        return response({ error: { code: failure.code, message: failure.code } }, failure.status)
      }
    },
  }), 'compute: private Comfy sample image')
}

function acceptanceBody(value: unknown): { id: string; decision: 'accept' | 'reject'; idempotencyKey: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ComputeError('COMPUTE_ACCEPTANCE_REQUEST_INVALID', 400)
  }
  const body = value as Record<string, unknown>
  if (Object.keys(body).sort().join(',') !== 'decision,id,idempotencyKey'
    || typeof body.id !== 'string' || body.id.length < 1 || body.id.length > 128
    || (body.decision !== 'accept' && body.decision !== 'reject')
    || typeof body.idempotencyKey !== 'string'
    || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(body.idempotencyKey)) {
    throw new ComputeError('COMPUTE_ACCEPTANCE_REQUEST_INVALID', 400)
  }
  return { id: body.id, decision: body.decision, idempotencyKey: body.idempotencyKey }
}

/** An unreadable Guangzhou session does not establish an authenticated image route. */
async function guangzhouAccountState(ctx: Context): Promise<GuangzhouAccountState> {
  const account = ctx.get('qianshouAccount') as { state?: () => Promise<{ phase?: unknown }> } | undefined
  if (typeof account?.state !== 'function') return 'unknown'
  try {
    const phase = (await account.state()).phase
    if (phase === 'authenticated') return 'signed-in'
    if (phase === 'signed-out' || phase === 'expired') return 'signed-out'
  } catch { /* An unreadable session does not establish cloud availability. */ }
  return 'unknown'
}

/** Read the workload identity out of a POST body without ever treating it as a path. */
function workloadIdFromBody(body: unknown): string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ComputeError('INVALID_COMPUTE_JSON')
  const id = (body as Record<string, unknown>).id
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(id) || id === '.' || id === '..') {
    throw new ComputeError('COMPUTE_WORKLOAD_ID_INVALID', 400)
  }
  return id
}
