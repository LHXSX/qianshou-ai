/** Owner-local discovery and an explicitly configured Guangzhou session. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { symbols, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { discoverLocalMedia } from './local-media-discovery.ts'
import { MediaNodeChannel, mediaNodeOrigin, type MediaNodeChannelOptions } from './media-node-channel.ts'
import type { SharingNodeSession } from './sharing-types.ts'
import { NodeContributorError } from './errors.ts'

/** A separately installed provider must validate Shanghai leases and persist admissions. */
export interface MediaNodeExecutionPort {
  readonly capabilityRevision: string
  readonly capabilities: MediaNodeChannelOptions['capabilities']
  readonly maxConcurrency: number
  readonly readHeartbeat: MediaNodeChannelOptions['readHeartbeat']
  readonly onTask: MediaNodeChannelOptions['onTask']
  readonly onApiProbe?: MediaNodeChannelOptions['onApiProbe']
}

/** Host-private channel control used by the automatic sharing coordinator. */
export interface MediaNodePresenceLease {
  /** Observe only the exact channel start owned by this lease, including reconnections. */
  current(): ReturnType<MediaNodeChannel['status']> | undefined
  /** Withdraw only this channel start and the currently observed epoch, atomically. */
  disconnect(epoch: number): Promise<boolean>
}

/** Host-private channel control used by the automatic sharing coordinator. */
export interface MediaNodeControl {
  prepare(): Promise<string>
  connect(): Promise<void>
  disconnect(): Promise<void>
  status(): ReturnType<MediaNodeChannel['status']> | undefined
  session(): SharingNodeSession | undefined
  connectOwned?(): Promise<MediaNodePresenceLease | null>
  ownerId?(): string | null
}

/** Mount reversible owner routes without automatically enrolling or enabling intake.
 * @param ctx - Existing authenticated Host carrier.
 * @param options - Host-private identity and optional deployment-owned gateway.
 * @returns Host-private lifecycle controls; teardown aborts and drains the channel.
 */
export function registerMediaNodeRoutes(ctx: Context, options: {
  readonly gatewayOrigin: string
  readonly directory: string
  readonly adapterVersion: string
  readonly ownerId: () => Promise<number | undefined>
  readonly accessToken: () => Promise<string | undefined>
  readonly reconnectInitialMs: number
  readonly reconnectMaxMs: number
  readonly requestTimeoutMs: number
  readonly waitMs: number
  readonly discoveryTimeoutMs: number
}): MediaNodeControl {
  const origin = options.gatewayOrigin === '' ? null : mediaNodeOrigin(options.gatewayOrigin)
  let channel: MediaNodeChannel | undefined
  let channelOwnerId: string | undefined
  let connecting: Promise<void> | undefined
  let reconnectController: AbortController | undefined
  let channelStart: object | undefined
  let live = true
  let serial: Promise<unknown> = Promise.resolve()
  const transaction = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serial.then(operation)
    serial = result.catch(() => undefined)
    return result
  }
  const executor = (): MediaNodeExecutionPort | undefined => ctx.get('qianshouMediaNodeExecutor') as MediaNodeExecutionPort | undefined
  const original = (port: MediaNodeExecutionPort | undefined): unknown =>
    port === undefined ? undefined : Reflect.get(port, symbols.original) ?? port
  const captureExecutor = () => {
    const port = executor()
    const capabilities = Object.freeze((port?.capabilities ?? []).map(capability => Object.freeze({
      profile_id: capability.profile_id, profile_version: capability.profile_version, model_sha256: capability.model_sha256,
      workflow_sha256: capability.workflow_sha256, validation_receipt_sha256: capability.validation_receipt_sha256,
    })))
    return { port, identity: original(port), capabilityRevision: port?.capabilityRevision ?? 'no-verified-media-profiles',
      capabilities, capabilityDigest: createHash('sha256').update(JSON.stringify(capabilities)).digest('hex'),
      maxConcurrency: port?.maxConcurrency ?? 1 }
  }
  type ExecutionSnapshot = ReturnType<typeof captureExecutor>
  let boundExecutor: ExecutionSnapshot | undefined
  const sameExecutor = (left: ExecutionSnapshot | undefined, right: ExecutionSnapshot): boolean =>
    left !== undefined && left.identity === right.identity && left.capabilityRevision === right.capabilityRevision
    && left.capabilityDigest === right.capabilityDigest && left.maxConcurrency === right.maxConcurrency
  if (!Number.isSafeInteger(options.reconnectInitialMs) || options.reconnectInitialMs < 100
    || !Number.isSafeInteger(options.reconnectMaxMs) || options.reconnectMaxMs < options.reconnectInitialMs
    || options.reconnectMaxMs > 60000) throw new NodeContributorError('MEDIA_NODE_RECONNECT_CONFIG_INVALID')
  if (!Number.isSafeInteger(options.waitMs) || options.waitMs < 1 || options.waitMs > 25000
    || !Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < options.waitMs + 1000
    || options.requestTimeoutMs > 60000 || !Number.isSafeInteger(options.discoveryTimeoutMs)
    || options.discoveryTimeoutMs < 100 || options.discoveryTimeoutMs > 30000) {
    throw new NodeContributorError('MEDIA_NODE_CONFIG_INVALID')
  }
  const stop = async (): Promise<void> => {
    channelStart = undefined
    reconnectController?.abort()
    await channel?.close()
    await connecting
  }
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
  const owner = async (): Promise<string> => {
    const id = await options.ownerId()
    if (id === undefined || !Number.isSafeInteger(id) || id < 1) throw new NodeContributorError('MEDIA_NODE_OWNER_UNAVAILABLE')
    return String(id)
  }
  const snapshot = () => ({ configured: origin !== null, executionConfigured: ctx.get('qianshouMediaNodeExecutor') !== undefined,
    billing: 'unavailable', ...(channel?.status() ?? { state: 'idle', deviceId: null, connectionEpoch: 0, sequence: 0,
      errorCode: null, withdrawalConfirmed: null, authorized: false, heartbeatAt: null }) })
  const connect = async (start = true): Promise<void> => {
    if (!live || origin === null) throw new NodeContributorError('MEDIA_NODE_GATEWAY_UNCONFIGURED')
    const ownerId = await owner()
    const captured = captureExecutor()
    if (channel !== undefined && (channelOwnerId !== ownerId || !sameExecutor(boundExecutor, captured))) {
      await stop(); channel = undefined
    }
    if (start && connecting !== undefined) return
    if (start && (channel?.status().state === 'connected' || channel?.status().state === 'connecting')) return
    const port = captured.port
    boundExecutor = captured
    if (channel?.status().state === 'closed') channel = undefined
    channelOwnerId = ownerId
    channel ??= new MediaNodeChannel({ origin, directory: join(options.directory,
      createHash('sha256').update(origin + ':' + ownerId).digest('hex')), ownerId,
    adapterVersion: options.adapterVersion, capabilityRevision: captured.capabilityRevision,
    capabilities: captured.capabilities, maxConcurrency: captured.maxConcurrency,
    requestTimeoutMs: options.requestTimeoutMs, waitMs: options.waitMs,
    maxResponseBytes: 17 * 1024 * 1024, readAccessToken: options.accessToken,
    assertOwner: async () => {
      if (!live || await owner() !== ownerId) throw new NodeContributorError('MEDIA_NODE_OWNER_CHANGED')
      if (!sameExecutor(captured, captureExecutor())) {
        throw new NodeContributorError('MEDIA_NODE_EXECUTOR_CHANGED')
      }
    },
    readHeartbeat: async () => {
      if (port === undefined || ctx.get('qianshouMediaNodeExecutor') === undefined) {
        return { freeSlots: 0, runningAttemptIds: [], freeVramMb: 0, availableSeconds: 0 }
      }
      return port.readHeartbeat()
    },
    onTask: async (task, signal, session) => {
      if (port === undefined || ctx.get('qianshouMediaNodeExecutor') === undefined) {
        throw new NodeContributorError('MEDIA_NODE_DISPATCH_UNCONFIGURED')
      }
      await port.onTask(task, signal, session)
    },
    onApiProbe: async (probe, signal, session) => { await port?.onApiProbe?.(probe, signal, session) },
    })
    await channel.prepare()
    if (!start) return
    // The response is a connection observation. Session failure stays visible and never opens new intake.
    const selected = channel
    channelStart = {}
    const controller = new AbortController(); reconnectController = controller
    const stopped = (): boolean => !live || controller.signal.aborted
    const running = (async () => {
      let delay = options.reconnectInitialMs
      while (!stopped()) {
        try { await selected.run(); break }
        catch {
          const code = selected.status().errorCode
          if (stopped() || code?.includes('OWNER') || code?.includes('EXECUTOR') || code === 'MEDIA_NODE_AUTH_REJECTED') break
          await pause(Math.min(options.reconnectMaxMs, Math.round(delay * (0.8 + Math.random() * 0.4))), controller.signal)
          delay = Math.min(options.reconnectMaxMs, delay * 2)
        }
      }
    })().finally(() => { if (connecting === running) { connecting = undefined; reconnectController = undefined } })
    connecting = running
  }
  ctx.effect(() => async () => { live = false; await transaction(stop) }, 'media node: outbound lifecycle')
  const routes: { path: string; method: 'GET' | 'POST'; run: (request: Request) => Promise<unknown> }[] = [
    { path: 'status', method: 'GET', run: async (_request: Request) => transaction(async () => {
      if (await owner() !== channelOwnerId && channel !== undefined) { await stop(); channel = undefined }
      return snapshot()
    }) },
    { path: 'connect', method: 'POST', run: async (_request: Request) => transaction(async () => { await connect(); return snapshot() }) },
    { path: 'disconnect', method: 'POST', run: async (_request: Request) => transaction(async () => { await owner(); await stop(); return snapshot() }) },
    { path: 'discover', method: 'POST', run: async (request: Request) => {
      await owner()
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw new NodeContributorError('MEDIA_DISCOVERY_JSON_REQUIRED')
      const text = await request.text()
      if (Buffer.byteLength(text) > 1024) throw new NodeContributorError('MEDIA_DISCOVERY_REQUEST_TOO_LARGE')
      let input: unknown
      try { input = JSON.parse(text) as unknown } catch { throw new NodeContributorError('MEDIA_DISCOVERY_INVALID') }
      if (input === null || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).join(',') !== 'origin' || typeof Reflect.get(input, 'origin') !== 'string') {
        throw new NodeContributorError('MEDIA_DISCOVERY_INVALID')
      }
      return discoverLocalMedia(Reflect.get(input, 'origin') as string, { signal: request.signal, timeoutMs: options.discoveryTimeoutMs })
    } },
  ]
  for (const route of routes) ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/node/media/' + route.path, methods: [route.method], requestBody: 'buffered',
    fetch: async (request) => {
      try { return Response.json(await route.run(request), { headers }) }
      catch (error) {
        const code = error instanceof NodeContributorError ? error.code : 'MEDIA_NODE_REQUEST_FAILED'
        return Response.json({ error: { code } }, { headers, status: code.includes('OWNER') ? 403 : code.includes('UNCONFIGURED') ? 503 : 400 })
      }
    },
  }), 'media node: ' + route.path)
  return { prepare: () => transaction(async () => { await connect(false); const id = channel?.status().deviceId; if (!id) throw new NodeContributorError('MEDIA_NODE_OWNER_UNAVAILABLE'); return id }),
    connect: () => transaction(async () => connect()), disconnect: () => transaction(stop),
    connectOwned: () => transaction(async () => {
      const previous = channelStart
      await connect()
      const selected = channel; const start = channelStart
      if (selected === undefined || start === undefined || start === previous) return null
      return { current: () => channel === selected && channelStart === start ? selected.status() : undefined,
        disconnect: epoch => transaction(async () => {
          if (channel !== selected || channelStart !== start || selected.status().connectionEpoch !== epoch) return false
          await stop(); return true
        }) }
    }),
    ownerId: () => channelOwnerId ?? null,
    status: () => channel?.status(), session: () => channel?.session() }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const aborted = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve() }, ms)
    signal.addEventListener('abort', aborted, { once: true })
  })
}
