/** Public device-credential carrier for Guangzhou's outbound node connection, plus Shanghai-only metadata ingress. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Principal } from './admin-routes.ts'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { MediaNodeError, MediaNodeStore, mediaNodeId, mediaNodeInteger, parseMediaNodeRegistration, type MediaNodeDispatch } from './media-node-store.ts'
import { verifyMediaResultVerdict, verifyMediaDirectoryQualification } from './media-result-contract.ts'
import type { MediaExchangeHttp } from './media-exchange-http.ts'

interface NodeRoute {
  readonly kind: 'exact'; readonly path: string
  readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
}

/** Runtime settings; no node service or dispatch route is registered without explicit configuration. */
export interface MediaNodeHttpOptions {
  store: MediaNodeStore
  verifyAccount: (request: Request) => Promise<(Principal & { username?: string | null }) | null>
  dispatchToken: () => Promise<string | undefined>
  maxLongPollRequests: number
  /** Dedicated read-only Shanghai research registry identity, with no dispatcher authority. */
  researchDirectoryToken?: () => Promise<string | undefined>
  /** Research tasks use an independent service identity; directory readers cannot place work. */
  researchDispatchToken?: () => Promise<string | undefined>
  resultVerifierPublicKeys?: Readonly<Record<string, string>>
  mediaExchange?: MediaExchangeHttp
  /** Reviewed metadata may serve while the formal byte/verifier exchange remains closed. */
  mediaMetadata?: Pick<MediaExchangeHttp, 'post'>
  /** Dedicated administrator service credential; never Shanghai dispatcher or a user's account token. */
  adminControl?: { readonly keyId: string; readonly audience: string; readonly scopes: readonly ('nodes.read' | 'nodes.manage')[];
    readonly token: () => Promise<string | undefined> }
}

/** Mount on the existing webServer. Authentication is request-bound and never uses its browser owner session.
 * @param options - Private durable directory, Shanghai account verifier and internal service credential reader.
 * @returns Routes and an async disposer that aborts and drains long polls before closing the database.
 */
export function createMediaNodeRoutes(options: MediaNodeHttpOptions): { routes: readonly NodeRoute[]; close: () => Promise<void> } {
  const admin = options.adminControl
  if (admin && (!/^[A-Za-z0-9_-]{1,64}$/u.test(admin.keyId) || typeof admin.audience !== 'string' || !admin.audience.trim() || admin.audience.length > 128
    || !Array.isArray(admin.scopes) || admin.scopes.length < 1 || admin.scopes.length > 2 || new Set(admin.scopes).size !== admin.scopes.length
    || admin.scopes.some(s => s !== 'nodes.read' && s !== 'nodes.manage'))) throw new Error('MEDIA_ADMIN_CONFIG_INVALID')
  const maxPolls = mediaNodeInteger(options.maxLongPollRequests, 256, 1)
  const lifecycle = new AbortController()
  const active = new Set<Promise<void>>()
  let polls = 0
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  const route = (path: string, operation: (token: string, body: Record<string, unknown>, request: IncomingMessage, response: ServerResponse) => Promise<unknown>): NodeRoute => ({
    kind: 'exact', path,
    handler: async (incoming, outgoing) => {
      const abortBody = (): void => { if (!incoming.complete) incoming.destroy() }
      lifecycle.signal.addEventListener('abort', abortBody, { once: true })
      const task = (async (): Promise<void> => {
        try {
          if (lifecycle.signal.aborted) throw new MediaNodeError('MEDIA_NODE_UNAVAILABLE', 503)
          if (incoming.method !== 'POST') throw new MediaNodeError('METHOD_NOT_ALLOWED', 405)
          if (incoming.url !== path) throw new MediaNodeError('BAD_REQUEST')
          if (incoming.headers.origin !== undefined || incoming.headers.cookie !== undefined || incoming.headers['sec-fetch-site'] === 'cross-site') throw new MediaNodeError('CROSS_ORIGIN_FORBIDDEN', 403)
          const authCount = incoming.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization').length
          const token = typeof incoming.headers.authorization === 'string' ? /^Bearer ([A-Za-z0-9._~+/-]{16,4096}=*)$/u.exec(incoming.headers.authorization)?.[1] : undefined
          if (authCount !== 1 || !token) throw new MediaNodeError('LOGIN_REQUIRED', 401)
          if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(String(incoming.headers['content-type'])) || incoming.headers['content-encoding'] !== undefined) throw new MediaNodeError('BAD_REQUEST')
          const announced = Number(incoming.headers['content-length'] ?? 0)
          if (!Number.isSafeInteger(announced) || announced < 0 || announced > 128 * 1024) throw new MediaNodeError('PAYLOAD_TOO_LARGE', 413)
          const chunks: Buffer[] = []; let size = 0
          for await (const chunk of incoming) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
            size += bytes.length
            if (size > 128 * 1024) throw new MediaNodeError('PAYLOAD_TOO_LARGE', 413)
            chunks.push(bytes)
          }
          let decoded: unknown
          try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown }
          catch { throw new MediaNodeError('BAD_REQUEST') }
          if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new MediaNodeError('BAD_REQUEST')
          const result = await operation(token, decoded as Record<string, unknown>, incoming, outgoing)
          if (outgoing.destroyed) return
          outgoing.writeHead(200, headers); outgoing.end(JSON.stringify(result))
        } catch (error) {
          if (outgoing.destroyed) return
          const classified = error instanceof MediaNodeError ? error : new MediaNodeError('MEDIA_NODE_UNAVAILABLE', 503)
          outgoing.writeHead(classified.status, { ...headers, ...(classified.status === 405 ? { allow: 'POST' } : {}) })
          outgoing.end(JSON.stringify({ ok: false, code: classified.code }))
        }
      })()
      active.add(task)
      try { await task } finally { active.delete(task); lifecycle.signal.removeEventListener('abort', abortBody) }
    },
  })
  const internal = async (token: string): Promise<void> => {
    const expected = await options.dispatchToken()
    if (!expected || expected.length < 32) throw new MediaNodeError('SHANGHAI_DISPATCH_NOT_CONFIGURED', 503)
    const provided = Buffer.from(token); const configured = Buffer.from(expected)
    if (provided.length !== configured.length || !timingSafeEqual(provided, configured)) throw new MediaNodeError('SHANGHAI_SERVICE_REQUIRED', 401)
  }
  const researchInternal = async (token: string): Promise<void> => {
    const expected = await options.researchDispatchToken?.()
    if (!expected || !/^[A-Za-z0-9_-]{43,256}$/u.test(expected)) throw new MediaNodeError('RESEARCH_DISPATCH_NOT_CONFIGURED', 503)
    const other = [await options.dispatchToken(), await options.researchDirectoryToken?.(), await options.adminControl?.token()]
    if (other.some(value => value === expected)) throw new MediaNodeError('RESEARCH_DISPATCH_IDENTITY_CONFLICT', 503)
    const supplied = Buffer.from(token); const configured = Buffer.from(expected)
    if (supplied.length !== configured.length || !timingSafeEqual(supplied, configured)) throw new MediaNodeError('RESEARCH_DISPATCH_SERVICE_REQUIRED', 401)
  }
  const identity = (body: Record<string, unknown>): [string, number] => [mediaNodeId(body['deviceId']), mediaNodeInteger(body['connectionEpoch'], Number.MAX_SAFE_INTEGER, 1)]
  const probe: NodeRoute = { kind: 'exact', path: '/v1/nodes/probe', handler: async (incoming, outgoing) => {
    const reject = (status: number, code: string): void => { outgoing.writeHead(status, { ...headers, ...(status === 405 ? { allow: 'GET' } : {}) }); outgoing.end(JSON.stringify({ ok: false, code })) }
    if (incoming.method !== 'GET') return reject(405, 'METHOD_NOT_ALLOWED')
    const nonce = /^\/v1\/nodes\/probe\?nonce=([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.exec(incoming.url ?? '')?.[1]
    if (!nonce) return reject(400, 'BAD_REQUEST')
    outgoing.writeHead(200, headers)
    outgoing.end(JSON.stringify({ schema: 'qianshou.media-gateway-probe.v1', service: 'qianshou-guangzhou-media', nonce, time: Math.floor(Date.now() / 1000) }))
  } }
  let transfers = 0
  const privateTransfer = (path: string, method: 'POST' | 'GET', operation: (incoming: IncomingMessage, outgoing: ServerResponse, token: string) => Promise<void>): NodeRoute => ({
    kind: 'exact', path, handler: async (incoming, outgoing) => {
      const abort = (): void => { if (!incoming.complete) incoming.destroy() }
      const task = (async (): Promise<void> => {
        try {
          if (lifecycle.signal.aborted) throw new MediaNodeError('MEDIA_NODE_UNAVAILABLE', 503)
          if (incoming.method !== method) throw new MediaNodeError('METHOD_NOT_ALLOWED', 405)
          if (incoming.headers.origin !== undefined || incoming.headers.cookie !== undefined || incoming.headers['sec-fetch-site'] === 'cross-site') throw new MediaNodeError('CROSS_ORIGIN_FORBIDDEN', 403)
          const count = incoming.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization').length
          const token = typeof incoming.headers.authorization === 'string' ? /^Bearer ([A-Za-z0-9._~+/-]{16,4096}=*)$/u.exec(incoming.headers.authorization)?.[1] : undefined
          if (count !== 1 || !token) throw new MediaNodeError('LOGIN_REQUIRED', 401)
          if (transfers >= 2) throw new MediaNodeError('RESEARCH_RESULT_TRANSFER_BUSY', 429)
          transfers++
          try { await operation(incoming, outgoing, token) } finally { transfers-- }
        } catch (error) {
          if (outgoing.destroyed) return
          const e = error instanceof MediaNodeError ? error : new MediaNodeError('RESEARCH_RESULT_UNAVAILABLE', 503)
          outgoing.writeHead(e.status, { ...headers, ...(e.status === 405 ? { allow: method } : {}) }); outgoing.end(JSON.stringify({ ok: false, code: e.code }))
        }
      })()
      lifecycle.signal.addEventListener('abort', abort, { once: true }); active.add(task)
      try { await task } finally { active.delete(task); lifecycle.signal.removeEventListener('abort', abort) }
    },
  })
  const resultUpload = privateTransfer('/v1/nodes/research/results/upload', 'POST', async (incoming, outgoing, token) => {
    if (incoming.url !== '/v1/nodes/research/results/upload' || incoming.headers['content-type'] !== 'image/png' || incoming.headers['content-encoding'] !== undefined) throw new MediaNodeError('RESEARCH_RESULT_UPLOAD_INVALID')
    const value = (name: string): string => {
      if (incoming.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === name).length !== 1 || typeof incoming.headers[name] !== 'string') throw new MediaNodeError('RESEARCH_RESULT_UPLOAD_INVALID')
      return incoming.headers[name]
    }
    const integer = (name: string): number => { const raw = value(name); if (!/^[1-9][0-9]*$/u.test(raw)) throw new MediaNodeError('RESEARCH_RESULT_UPLOAD_INVALID'); return mediaNodeInteger(Number(raw), Number.MAX_SAFE_INTEGER, 1) }
    const body = { deviceId: mediaNodeId(value('x-qianshou-device-id')), connectionEpoch: integer('x-qianshou-connection-epoch'), taskId: value('x-qianshou-task-id'), attemptId: value('x-qianshou-attempt-id'), leaseEpoch: integer('x-qianshou-lease-epoch') }
    const digest = value('x-qianshou-sha256')
    if (!/^[0-9a-f]{64}$/u.test(digest)) throw new MediaNodeError('RESEARCH_RESULT_UPLOAD_INVALID')
    const announced = integer('content-length')
    if (announced > 64 * 1024 * 1024) throw new MediaNodeError('PAYLOAD_TOO_LARGE', 413)
    options.store.authenticateResearchResult(body.deviceId, token, body)
    const chunks: Buffer[] = []; let size = 0
    const timeout = setTimeout(() => incoming.destroy(), 30_000)
    try {
      for await (const chunk of incoming) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); size += bytes.length
        if (size > announced) throw new MediaNodeError('RESEARCH_RESULT_UPLOAD_INVALID')
        chunks.push(bytes)
      }
    } finally { clearTimeout(timeout) }
    if (size !== announced) throw new MediaNodeError('RESEARCH_RESULT_UPLOAD_INVALID')
    const result = options.store.researchUpload(body.deviceId, token, body, digest, Buffer.concat(chunks))
    outgoing.writeHead(200, headers); outgoing.end(JSON.stringify(result))
  })
  const resultDownload = privateTransfer('/v1/media/research/result', 'GET', async (incoming, outgoing, token) => {
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
    const match = new RegExp('^/v1/media/research/result\\?taskId=(' + uuid + ')&attemptId=(' + uuid + ')$', 'u').exec(incoming.url ?? '')
    if (!match?.[1] || !match[2]) throw new MediaNodeError('RESEARCH_MESSAGE_INVALID')
    const principal = await options.verifyAccount(new Request('https://qianshou.local/v1/media/research/result', { headers: { authorization: `Bearer ${token}` } }))
    if (!principal || !/^[1-9][0-9]*$/u.test(principal.accountId)) throw new MediaNodeError('LOGIN_REQUIRED', 401)
    const result = options.store.researchOwnerResult(principal.accountId, match[1], match[2])
    outgoing.writeHead(200, { ...headers, 'content-type': 'image/png', 'content-length': result.bytes.length,
      'content-disposition': `inline; filename="${match[1]}.png"`, 'x-qianshou-sha256': String(result.artifact['sha256']) })
    outgoing.end(result.bytes)
  })

  const routes = [
    probe,
    resultUpload,
    resultDownload,
    route('/v1/media/install-manifest', async (token, body) => {
      const metadata = options.mediaMetadata ?? options.mediaExchange
      if (!metadata) throw new MediaNodeError('MEDIA_INSTALL_CATALOG_UNAVAILABLE', 503)
      const fields = ['nonce', 'deviceId', 'workerId', 'mode', 'platform', 'arch', 'hardware']
      if (Object.keys(body).length !== fields.length || Object.keys(body).some(k => !fields.includes(k))) throw new MediaNodeError('MEDIA_INSTALL_MANIFEST_INVALID')
      const principal = await options.verifyAccount(new Request('https://qianshou.local/v1/media/install-manifest', { headers: { authorization: `Bearer ${token}` } }))
      if (!principal || !/^[1-9][0-9]*$/u.test(principal.accountId) || !Number.isSafeInteger(Number(principal.accountId))) throw new MediaNodeError('LOGIN_REQUIRED', 401)
      return metadata.post('/internal/media/install-manifest', { ...body, accountId: Number(principal.accountId) })
    }),
    route('/v1/media/devices/qualification', async (token, body) => {
      const metadata = options.mediaMetadata ?? options.mediaExchange
      if (!metadata) throw new MediaNodeError('MEDIA_QUALIFICATION_UNAVAILABLE', 503)
      const fields = ['nonce', 'deviceId', 'workerId']
      if (Object.keys(body).length !== fields.length || Object.keys(body).some(k => !fields.includes(k))) throw new MediaNodeError('MEDIA_QUALIFICATION_INVALID')
      const principal = await options.verifyAccount(new Request('https://qianshou.local/v1/media/devices/qualification', { headers: { authorization: `Bearer ${token}` } }))
      if (!principal || !/^[1-9][0-9]*$/u.test(principal.accountId) || !Number.isSafeInteger(Number(principal.accountId))) throw new MediaNodeError('LOGIN_REQUIRED', 401)
      return metadata.post('/internal/media/devices/qualification', { ...body, accountId: Number(principal.accountId) })
    }),
    route('/v1/media/assets/ticket', async (token, body) => {
      if (!options.mediaExchange) throw new MediaNodeError('MEDIA_ASSETS_UNAVAILABLE', 503)
      const keys = ['assetId', 'role', 'sha256', 'size_bytes', 'content_type']
      if (Object.keys(body).length !== keys.length || Object.keys(body).some(key => !keys.includes(key))) throw new MediaNodeError('MEDIA_ASSET_INVALID')
      const principal = await options.verifyAccount(new Request('https://qianshou.local/v1/media/assets/ticket', { headers: { authorization: `Bearer ${token}` } }))
      if (!principal || !/^[1-9][0-9]*$/u.test(principal.accountId) || !Number.isSafeInteger(Number(principal.accountId))) throw new MediaNodeError('LOGIN_REQUIRED', 401)
      return options.mediaExchange.post('/internal/media/assets/ticket', { ...body, accountId: Number(principal.accountId) })
    }),
    route('/v1/media/assets/status', async (token, body) => {
      if (!options.mediaExchange) throw new MediaNodeError('MEDIA_ASSETS_UNAVAILABLE', 503)
      if (Object.keys(body).length !== 1 || typeof body['assetId'] !== 'string') throw new MediaNodeError('MEDIA_ASSET_INVALID')
      const principal = await options.verifyAccount(new Request('https://qianshou.local/v1/media/assets/status', { headers: { authorization: `Bearer ${token}` } }))
      if (!principal || !/^[1-9][0-9]*$/u.test(principal.accountId) || !Number.isSafeInteger(Number(principal.accountId))) throw new MediaNodeError('LOGIN_REQUIRED', 401)
      return options.mediaExchange.post('/internal/media/assets/status', { accountId: Number(principal.accountId), assetId: body['assetId'] })
    }),
    route('/internal/media/capabilities', async (token, body) => {
      await internal(token)
      if (Object.keys(body).length !== 0) throw new MediaNodeError('BAD_REQUEST')
      return { ok: true, schema: 'qianshou.formal-media-gateway.v1', features: {
        directory: true, dispatch_reconcile: options.store.formalAuthorizationConfigured(), event_journal: true,
        settlement_ack: true, result_verdict_admission: Object.keys(options.resultVerifierPublicKeys ?? {}).length > 0 } }
    }),
    route('/v1/nodes/media/result-ticket', async (token, body) => {
      if (!options.mediaExchange) throw new MediaNodeError('MEDIA_RESULT_UPLOAD_UNAVAILABLE', 503)
      const fields = ['deviceId', 'connectionEpoch', 'taskId', 'attemptId', 'leaseEpoch', 'assetId', 'sha256', 'size_bytes', 'content_type']
      if (Object.keys(body).length !== fields.length || Object.keys(body).some(k => !fields.includes(k))) throw new MediaNodeError('MEDIA_RESULT_UPLOAD_INVALID')
      const [device, epoch] = identity(body)
      options.store.authenticateResultUpload(device, token, epoch, mediaNodeId(body['taskId']), mediaNodeId(body['attemptId']), mediaNodeInteger(body['leaseEpoch'], Number.MAX_SAFE_INTEGER, 1))
      const { connectionEpoch: _epoch, ...request } = body
      return options.mediaExchange.post('/internal/media/results/ticket', request)
    }),
    route('/v1/nodes/media/input-ticket', async (token, body) => {
      if (!options.mediaExchange) throw new MediaNodeError('MEDIA_INPUT_READ_UNAVAILABLE', 503)
      const fields = ['deviceId', 'connectionEpoch', 'taskId', 'attemptId', 'leaseEpoch', 'assetId', 'sha256']
      if (Object.keys(body).length !== fields.length || Object.keys(body).some(k => !fields.includes(k))) throw new MediaNodeError('MEDIA_INPUT_READ_INVALID')
      const [device, epoch] = identity(body)
      options.store.authenticateResultUpload(device, token, epoch, mediaNodeId(body['taskId']), mediaNodeId(body['attemptId']), mediaNodeInteger(body['leaseEpoch'], Number.MAX_SAFE_INTEGER, 1))
      const { connectionEpoch: _epoch, ...request } = body
      return options.mediaExchange.post('/internal/media/assets/read-ticket', request)
    }),
    route('/v1/nodes/media/order-current', async (token, body) => {
      if (!options.mediaExchange) throw new MediaNodeError('MEDIA_ORDER_CURRENT_UNAVAILABLE', 503)
      const fields = ['deviceId', 'connectionEpoch', 'taskId', 'attemptId', 'leaseEpoch']
      if (Object.keys(body).length !== fields.length || Object.keys(body).some(k => !fields.includes(k))) throw new MediaNodeError('MEDIA_ORDER_CURRENT_INVALID')
      const [device, epoch] = identity(body)
      options.store.authenticateResultUpload(device, token, epoch, mediaNodeId(body['taskId']), mediaNodeId(body['attemptId']), mediaNodeInteger(body['leaseEpoch'], Number.MAX_SAFE_INTEGER, 1))
      const { connectionEpoch: _epoch, ...request } = body
      return options.mediaExchange.post('/internal/media/order-current', request)
    }),
    route('/v1/nodes/media/task-status', async (token, body) => {
      const fields = ['deviceId', 'connectionEpoch', 'taskId', 'attemptId', 'leaseEpoch']
      if (Object.keys(body).length !== fields.length || Object.keys(body).some(k => !fields.includes(k))) throw new MediaNodeError('MEDIA_TASK_QUERY_INVALID')
      const [device, epoch] = identity(body); const task = mediaNodeId(body['taskId']); const attempt = mediaNodeId(body['attemptId'])
      options.store.authenticateResultUpload(device, token, epoch, task, attempt, mediaNodeInteger(body['leaseEpoch'], Number.MAX_SAFE_INTEGER, 1), true)
      return options.store.taskStatus(task, attempt)
    }),
    route('/v1/nodes/media/result-status', async (token, body) => {
      if (!options.mediaExchange) throw new MediaNodeError('MEDIA_RESULT_UPLOAD_UNAVAILABLE', 503)
      const fields = ['deviceId', 'connectionEpoch', 'taskId', 'attemptId', 'leaseEpoch', 'assetId']
      if (Object.keys(body).length !== fields.length || Object.keys(body).some(k => !fields.includes(k))) throw new MediaNodeError('MEDIA_RESULT_UPLOAD_INVALID')
      const [device, epoch] = identity(body)
      options.store.authenticateResultUpload(device, token, epoch, mediaNodeId(body['taskId']), mediaNodeId(body['attemptId']), mediaNodeInteger(body['leaseEpoch'], Number.MAX_SAFE_INTEGER, 1), true)
      const { connectionEpoch: _epoch, ...request } = body
      return options.mediaExchange.post('/internal/media/results/status', request)
    }),
    route('/v1/nodes/register', async (token, body) => {
      const principal = await options.verifyAccount(new Request('https://qianshou.local/v1/nodes/register', { headers: { authorization: `Bearer ${token}` } }))
      if (!principal) throw new MediaNodeError('LOGIN_REQUIRED', 401)
      return options.store.register(principal.accountId, parseMediaNodeRegistration(body), principal.username)
    }),
    route('/internal/media/research/nodes', async (token, body) => {
      const expected = await options.researchDirectoryToken?.()
      if (!expected || !/^[A-Za-z0-9_-]{43,256}$/u.test(expected)) throw new MediaNodeError('RESEARCH_DIRECTORY_NOT_CONFIGURED', 503)
      const provided = Buffer.from(token); const configured = Buffer.from(expected)
      if (provided.length !== configured.length || !timingSafeEqual(provided, configured)) throw new MediaNodeError('RESEARCH_DIRECTORY_SERVICE_REQUIRED', 401)
      if (Object.keys(body).length !== 1 || typeof body['nonce'] !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(body['nonce'])) throw new MediaNodeError('RESEARCH_DIRECTORY_QUERY_INVALID')
      return options.store.researchDirectory(body['nonce'])
    }),
    route('/internal/media/research/dispatch', async (token, body) => {
      await researchInternal(token)
      return options.store.researchDispatch(body)
    }),
    route('/internal/media/research/task', async (token, body) => {
      await researchInternal(token)
      if (Object.keys(body).length !== 2 || Object.keys(body).some(k => !['taskId', 'attemptId'].includes(k))) throw new MediaNodeError('RESEARCH_MESSAGE_INVALID')
      return options.store.researchTaskStatus(mediaNodeId(body['taskId']), mediaNodeId(body['attemptId']))
    }),
    route('/v1/nodes/research/channel', async (token, body, _incoming, outgoing) => {
      const fields = ['deviceId', 'connectionEpoch', 'afterSequence', 'waitMs']
      if (Object.keys(body).length !== fields.length || Object.keys(body).some(k => !fields.includes(k))) throw new MediaNodeError('RESEARCH_MESSAGE_INVALID')
      const [deviceId, epoch] = identity(body)
      const after = mediaNodeInteger(body['afterSequence'], Number.MAX_SAFE_INTEGER)
      const wait = mediaNodeInteger(body['waitMs'], 25_000)
      let snapshot = options.store.researchChannel(deviceId, token, epoch, after)
      if ((snapshot['tasks'] as unknown[]).length || wait === 0) return snapshot
      if (polls >= maxPolls) throw new MediaNodeError('MEDIA_NODE_CHANNEL_BUSY', 429)
      polls++
      const aborted = new AbortController(); const abort = (): void => aborted.abort()
      outgoing.once('close', abort); lifecycle.signal.addEventListener('abort', abort, { once: true })
      try {
        const deadline = Date.now() + wait
        while (!aborted.signal.aborted && Date.now() < deadline) {
          await pause(Math.min(250, deadline - Date.now()), aborted.signal)
          if (aborted.signal.aborted) break
          snapshot = options.store.researchChannel(deviceId, token, epoch, after)
          if ((snapshot['tasks'] as unknown[]).length) break
        }
        return snapshot
      } finally { polls--; outgoing.off('close', abort); lifecycle.signal.removeEventListener('abort', abort) }
    }),
    route('/v1/nodes/research/claim', async (token, body) => options.store.researchClaim(mediaNodeId(body['deviceId']), token, body)),
    route('/v1/nodes/research/execution', async (token, body) => options.store.researchExecution(mediaNodeId(body['deviceId']), token, body)),
    route('/v1/nodes/device-info', async (token, body) => options.store.deviceInfo(mediaNodeId(body['deviceId']), token, body)),
    route('/v1/nodes/account-identity', async (token, body) => {
      if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'deviceId')) throw new MediaNodeError('BAD_REQUEST')
      const principal = await options.verifyAccount(new Request('https://qianshou.local/v1/nodes/account-identity', { headers: { authorization: `Bearer ${token}` } }))
      if (!principal) throw new MediaNodeError('LOGIN_REQUIRED', 401)
      return options.store.accountIdentity(principal.accountId, mediaNodeId(body['deviceId']), principal.username ?? null)
    }),
    route('/v1/nodes/research/events', async (token, body) => options.store.researchEvent(mediaNodeId(body['deviceId']), token, body)),
    route('/v1/nodes/research/task-status', async (token, body) => options.store.researchNodeStatus(mediaNodeId(body['deviceId']), token, body)),
    route('/v1/nodes/api-observations', async (token, body) => options.store.apiObservations(mediaNodeId(body['deviceId']), token, body)),
    route('/v1/nodes/api-probe-result', async (token, body) => options.store.apiProbeResult(mediaNodeId(body['deviceId']), token, body)),
    route('/v1/nodes/reconnect', async (token, body) => options.store.reconnect(mediaNodeId(body['deviceId']), token, mediaNodeId(body['capabilityRevision']))),
    route('/v1/nodes/disconnect', async (token, body) => {
      const [deviceId, epoch] = identity(body)
      return options.store.disconnect(deviceId, token, epoch)
    }),
    route('/v1/nodes/heartbeat', async (token, body) => options.store.heartbeat(mediaNodeId(body['deviceId']), token, body)),
    route('/v1/nodes/channel', async (token, body, _incoming, outgoing) => {
      const [deviceId, epoch] = identity(body)
      const after = mediaNodeInteger(body['afterSequence'], Number.MAX_SAFE_INTEGER)
      const wait = mediaNodeInteger(body['waitMs'], 25_000)
      let snapshot = options.store.channel(deviceId, token, epoch, after)
      if ((snapshot['tasks'] as unknown[]).length > 0 || ((snapshot['apiProbes'] as unknown[] | undefined)?.length ?? 0) > 0 || wait === 0) return snapshot
      if (polls >= maxPolls) throw new MediaNodeError('MEDIA_NODE_CHANNEL_BUSY', 429)
      polls++
      const aborted = new AbortController()
      const abort = (): void => aborted.abort()
      outgoing.once('close', abort)
      lifecycle.signal.addEventListener('abort', abort, { once: true })
      try {
        const deadline = Date.now() + wait
        while (!aborted.signal.aborted && Date.now() < deadline) {
          await pause(Math.min(250, deadline - Date.now()), aborted.signal)
          if (aborted.signal.aborted) break
          snapshot = options.store.channel(deviceId, token, epoch, after)
          if ((snapshot['tasks'] as unknown[]).length > 0 || ((snapshot['apiProbes'] as unknown[] | undefined)?.length ?? 0) > 0) break
        }
        return snapshot
      } finally { polls--; outgoing.off('close', abort); lifecycle.signal.removeEventListener('abort', abort) }
    }),
    route('/v1/nodes/events', async (token, body) => {
      const [device, epoch] = identity(body)
      if (body['assetId'] !== undefined || body['artifact'] !== undefined) {
        if (!options.mediaExchange || body['stage'] !== 'awaiting_settlement') throw new MediaNodeError('MEDIA_RESULT_UPLOAD_UNAVAILABLE', 503)
        options.store.authenticateResultUpload(device, token, epoch, mediaNodeId(body['taskId']), mediaNodeId(body['attemptId']), mediaNodeInteger(body['leaseEpoch'], Number.MAX_SAFE_INTEGER, 1), true)
        const original = await options.mediaExchange.post('/internal/media/results/status', Object.fromEntries(['deviceId', 'taskId', 'attemptId', 'leaseEpoch', 'assetId'].map(k => [k, body[k]])))
        if (!original['artifact'] || !body['artifact'] || typeof body['artifact'] !== 'object' || Array.isArray(body['artifact'])) throw new MediaNodeError('MEDIA_EVENT_ARTIFACT_INVALID')
        const saved = original['artifact'] as Record<string, unknown>; const supplied = body['artifact'] as Record<string, unknown>
        if (Object.keys(supplied).length !== 5 || ['object_key', 'object_version_id', 'sha256', 'size_bytes', 'content_type'].some(k => supplied[k] !== saved[k])) throw new MediaNodeError('MEDIA_EVENT_ARTIFACT_CONFLICT', 409)
        const p = verifyMediaResultVerdict(original['verdict'], options.resultVerifierPublicKeys ?? {})
        if (p.assetId !== body['assetId'] || p.deviceId !== device || p.taskId !== body['taskId'] || p.attemptId !== body['attemptId'] || p.leaseEpoch !== body['leaseEpoch']) throw new MediaNodeError('MEDIA_EVENT_ARTIFACT_CONFLICT', 409)
        options.store.recordResult(p, original['verdict'] as Record<string, unknown>)
      }
      return options.store.event(device, token, body)
    }),
    route('/internal/media/nodes', async token => {
      await internal(token)
      const nodes = options.store.directory()
      if (!options.mediaExchange || !options.store.formalAuthorizationConfigured()) return { ok: true, nodes }
      try {
        const nonce = randomUUID()
        const response = await options.mediaExchange.post('/internal/media/devices/verified', { nonce })
        const profiles = verifyMediaDirectoryQualification(response['qualification'], options.resultVerifierPublicKeys ?? {}, nonce)
        return { ok: true, nodes: nodes.map(node => {
          const advertised = node['media_profiles'] as Record<string, unknown>[]
          const matching = profiles.filter(p => p.deviceId === node['deviceId'] && p.ownerId === node['ownerId'] && advertised.some(a =>
            ['profile_id', 'profile_version', 'model_sha256', 'workflow_sha256', 'validation_receipt_sha256'].every(k => a[k] === p[k as keyof typeof p])))
          return { ...node, verification: matching.length > 0 ? 'official-profile-validation' : 'self-reported',
            media_exchange_ready: matching.length > 0, verified_media_profiles: matching }
        }) }
      } catch { return { ok: true, nodes } }
    }),
    route('/internal/media/task', async (token, body) => {
      await internal(token)
      if (Object.keys(body).length !== 2 || Object.keys(body).some(key => !['taskId', 'attemptId'].includes(key))) throw new MediaNodeError('MEDIA_TASK_QUERY_INVALID')
      return options.store.taskStatus(mediaNodeId(body['taskId']), mediaNodeId(body['attemptId']))
    }),
    route('/internal/media/events/read', async (token, body) => {
      await internal(token)
      if (Object.keys(body).length !== 3 || Object.keys(body).some(key => !['consumerId', 'afterSequence', 'limit'].includes(key))) throw new MediaNodeError('MEDIA_EVENT_READ_INVALID')
      return options.store.readEvents(mediaNodeId(body['consumerId']), mediaNodeInteger(body['afterSequence'], Number.MAX_SAFE_INTEGER), mediaNodeInteger(body['limit'], 128, 1))
    }),
    route('/internal/media/events/ack', async (token, body) => {
      await internal(token)
      if (Object.keys(body).length !== 2 || Object.keys(body).some(key => !['consumerId', 'sequence'].includes(key))) throw new MediaNodeError('MEDIA_EVENT_ACK_INVALID')
      return options.store.ackEvents(mediaNodeId(body['consumerId']), mediaNodeInteger(body['sequence'], Number.MAX_SAFE_INTEGER))
    }),
    route('/internal/media/results/record', async (token, body) => {
      await internal(token)
      if (Object.keys(body).length !== 1 || !body['verdict'] || typeof body['verdict'] !== 'object' || Array.isArray(body['verdict'])) throw new MediaNodeError('MEDIA_RESULT_INVALID')
      const verified = verifyMediaResultVerdict(body['verdict'], options.resultVerifierPublicKeys ?? {})
      return options.store.recordResult(verified, body['verdict'] as Record<string, unknown>)
    }),
    route('/internal/media/settlement', async (token, body) => { await internal(token); return options.store.settlement(body) }),
    route('/internal/media/dispatch', async (token, body) => {
      await internal(token)
      if (Object.keys(body).some(key => !['deviceId', 'taskId', 'attemptId', 'leaseEpoch', 'leaseExpiresAt', 'quoteId', 'authorizationId', 'envelope'].includes(key))) throw new MediaNodeError('MEDIA_DISPATCH_INVALID')
      if (!body['envelope'] || typeof body['envelope'] !== 'object' || Array.isArray(body['envelope']) || typeof body['leaseExpiresAt'] !== 'string') throw new MediaNodeError('MEDIA_DISPATCH_INVALID')
      const task: MediaNodeDispatch = { deviceId: mediaNodeId(body['deviceId']), taskId: mediaNodeId(body['taskId']), attemptId: mediaNodeId(body['attemptId']),
        leaseEpoch: mediaNodeInteger(body['leaseEpoch'], Number.MAX_SAFE_INTEGER, 1), leaseExpiresAt: body['leaseExpiresAt'],
        quoteId: mediaNodeId(body['quoteId']), authorizationId: mediaNodeId(body['authorizationId']), envelope: body['envelope'] as Record<string, unknown> }
      return options.store.dispatch(task)
    }),
  ]
  for (const action of ['list', 'detail', 'preflight', 'apply', 'check'] as const) routes.push(route('/internal/media/admin/' + action, async (token, body, incoming) => {
    const config = options.adminControl
    const expected = await config?.token()
    if (!config || !expected || !/^[A-Za-z0-9_-]{43,256}$/u.test(expected)) throw new MediaNodeError('MEDIA_ADMIN_NOT_CONFIGURED', 503)
    const supplied = Buffer.from(token); const trusted = Buffer.from(expected)
    if (incoming.headers['x-qianshou-service-key-id'] !== config.keyId || supplied.length !== trusted.length || !timingSafeEqual(supplied, trusted)) throw new MediaNodeError('MEDIA_ADMIN_UNAUTHORIZED', 401)
    if (!config.scopes.includes(action === 'list' || action === 'detail' ? 'nodes.read' : 'nodes.manage')) throw new MediaNodeError('MEDIA_ADMIN_FORBIDDEN', 403)
    const meta = body['_admin'] as Record<string, unknown> | undefined
    const uuid = (value: unknown): string => {
      if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new MediaNodeError('MEDIA_ADMIN_REQUEST_INVALID')
      return value
    }
    const ref = uuid(body['ref'])
    if (!meta || typeof meta !== 'object' || Array.isArray(meta) || Object.keys(meta).length !== 5
      || Object.keys(meta).some(k => !['audience', 'operatorAccountId', 'operatorRole', 'operationId', 'scope'].includes(k))
      || meta['audience'] !== config.audience || meta['operationId'] !== ref
      || typeof meta['operatorAccountId'] !== 'string' || !/^[1-9][0-9]*$/u.test(meta['operatorAccountId'])
      || typeof meta['operatorRole'] !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/u.test(meta['operatorRole'])
      || !['self', 'all'].includes(String(meta['scope']))) throw new MediaNodeError('MEDIA_ADMIN_FORBIDDEN', 403)
    const owner = meta['scope'] === 'self' ? meta['operatorAccountId'] : undefined
    const allowed = action === 'list' || action === 'check' ? ['ref', '_admin']
      : action === 'detail' ? ['deviceId', 'ref', '_admin']
        : action === 'preflight' ? ['deviceId', 'action', 'ref', '_admin']
          : ['deviceId', 'action', 'ref', 'reason', 'before', '_admin']
    if (Object.keys(body).length !== allowed.length || Object.keys(body).some(k => !allowed.includes(k))) throw new MediaNodeError('MEDIA_ADMIN_REQUEST_INVALID')
    if (action === 'list') return options.store.adminList(owner)
    if (action === 'check') return options.store.adminCheck(ref, meta['operatorAccountId'], owner)
    const deviceId = mediaNodeId(body['deviceId'])
    if (action === 'detail') return options.store.adminDetail(deviceId, owner)
    if (typeof body['action'] !== 'string' || !['pause', 'resume', 'revoke'].includes(body['action'])) throw new MediaNodeError('MEDIA_ADMIN_ACTION_INVALID')
    if (action === 'preflight') return options.store.adminPreview(deviceId, body['action'], ref, owner)
    if (!body['before'] || typeof body['before'] !== 'object' || Array.isArray(body['before']) || typeof body['reason'] !== 'string') throw new MediaNodeError('MEDIA_ADMIN_REQUEST_INVALID')
    return options.store.adminApply(deviceId, body['action'], ref, meta['operatorAccountId'], body['reason'], body['before'] as Record<string, unknown>, owner)
  }))
  if (options.mediaExchange) for (const path of ['/v1/media/assets/upload', '/v1/media/results/upload', '/v1/media/assets/read']) routes.push({
    kind: 'exact', path, handler: async (incoming, outgoing) => {
      const abort = (): void => { incoming.destroy(); outgoing.destroy() }
      lifecycle.signal.addEventListener('abort', abort, { once: true })
      const task = (async (): Promise<void> => {
        try {
          if (lifecycle.signal.aborted) throw new MediaNodeError('MEDIA_NODE_UNAVAILABLE', 503)
          if (path === '/v1/media/assets/read') await options.mediaExchange!.read(incoming, outgoing)
          else await options.mediaExchange!.upload(incoming, outgoing)
        } catch (error) {
          if (outgoing.destroyed || outgoing.headersSent) return
          const classified = error instanceof MediaNodeError ? error : new MediaNodeError('MEDIA_UPLOAD_OUTCOME_UNKNOWN', 503)
          outgoing.writeHead(classified.status, headers); outgoing.end(JSON.stringify({ ok: false, code: classified.code }))
        }
      })()
      active.add(task)
      try { await task } finally { active.delete(task); lifecycle.signal.removeEventListener('abort', abort) }
    },
  })
  return { routes, close: async () => { lifecycle.abort(); await Promise.allSettled([...active]); options.store.close() } }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve()
  return new Promise(resolve => {
    const abort = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
