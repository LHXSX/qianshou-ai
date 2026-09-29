/**
 * Transport adapter seam for a contributing node.
 *
 * This module deliberately knows nothing about WebSocket, HTTP, TLS or a
 * credential store. A platform adapter supplies `NodeTransport`; the adapter
 * uses the access token only while sending the authentication frame and never
 * stores it in durable session state.
 */
import { ComputeError } from './errors.ts'
import { parseNodeHeartbeat, parseNodeTaskOffer, type NodeHeartbeatMessage, type NodeTaskOfferMessage, type NodeTaskProgressMessage, type NodeTaskReturnMessage } from './node-protocol.ts'
import type { NodeConnectRequest, NodeSession, NodeSessionConnector } from './node-session.ts'

/** Frames emitted by the transport adapter. `auth` is ephemeral by contract. */
export type NodeTransportOutbound =
  | { type: 'auth'; endpoint: string; accessToken: string; heartbeat: NodeHeartbeatMessage }
  | { type: 'heartbeat'; message: NodeHeartbeatMessage }
  | { type: 'task.progress'; message: NodeTaskProgressMessage }
  | { type: 'task.return'; message: NodeTaskReturnMessage }

/** Frames received from the dispatch service. All untrusted offers are parsed before delivery. */
export type NodeTransportInbound =
  | { type: 'auth.accepted' }
  | { type: 'task.offer'; offer: unknown }
  | { type: 'error'; code: string }

/** Minimal transport implemented by HTTP, WebSocket, QUIC or an in-process test adapter. */
export interface NodeTransport {
  send(frame: NodeTransportOutbound): Promise<void>
  onMessage(handler: (frame: NodeTransportInbound) => void | Promise<void>): () => void
  onClose(handler: (reason?: string) => void): () => void
  close(reason?: string): Promise<void>
}

/** Factory owned by the deployment; it controls TLS, endpoint allow-lists and socket creation. */
export interface NodeTransportFactory {
  open(endpoint: string, signal?: AbortSignal): Promise<NodeTransport>
}

/** Bounds for authentication and pre-subscription offer buffering. */
export interface NodeTransportConnectorOptions {
  /** Bound the authentication handshake; prevents a half-open socket hanging forever. */
  authTimeoutMs: number
  /** Bound offers received before the first consumer subscribes; no silent loss. */
  maxPendingOffers: number
}

/**
 * Build the standard session connector around one concrete transport factory.
 * Authentication and frame routing are centralized here so every transport
 * has the same validation and no plugin can silently bypass the node protocol.
 * @param factory - Deployment-owned transport factory.
 * @param options - Authentication and pending-offer bounds.
 * @returns A transport-neutral node session connector.
 */
export function createNodeTransportConnector(factory: NodeTransportFactory, options: NodeTransportConnectorOptions): NodeSessionConnector {
  const factoryValue: unknown = factory
  if (factoryValue === null || typeof factoryValue !== 'object'
    || !('open' in factoryValue) || typeof factoryValue.open !== 'function') {
    throw new ComputeError('COMPUTE_NODE_TRANSPORT_FACTORY_INVALID')
  }
  if (!Number.isSafeInteger(options.authTimeoutMs) || options.authTimeoutMs < 1000 || options.authTimeoutMs > 60000
    || !Number.isSafeInteger(options.maxPendingOffers) || options.maxPendingOffers < 1 || options.maxPendingOffers > 256) throw new ComputeError('COMPUTE_NODE_CONNECT_OPTIONS_INVALID')
  return {
    connect: async (request: NodeConnectRequest, signal?: AbortSignal): Promise<NodeSession> => {
      const heartbeat = validateConnectRequest(request)
      if (signal?.aborted) throw abortError()
      const transport = await factory.open(request.endpoint, signal)
      let authenticated = false
      let closed = false
      const isSessionClosed = (): boolean => closed
      const offers = new Set<(offer: NodeTaskOfferMessage) => void | Promise<void>>()
      const pendingOffers: NodeTaskOfferMessage[] = []
      let deliveryTail: Promise<void> = Promise.resolve()
      let offMessage: () => void = () => {}
      let offClose: () => void = () => {}
      let resolveAuth!: () => void
      let rejectAuth!: (error: unknown) => void
      const auth = new Promise<void>((resolve, reject) => { resolveAuth = resolve; rejectAuth = reject })
      // Keep the deferred promise observed even if a platform timer fires
      // before the handshake microtask installs its combined await below.
      void auth.catch(() => {})
      let rejectTimeout!: (error: Error) => void
      const timeout = new Promise<void>((_resolve, reject) => { rejectTimeout = reject })
      void timeout.catch(() => {})
      const failSession = (reason: string): void => {
        if (closed) return
        closed = true
        pendingOffers.length = 0
        offMessage()
        offClose()
        void transport.close(reason).catch(() => { /* preserve the first session failure when teardown also fails */ })
      }
      const scheduleDelivery = (): void => {
        if (pendingOffers.length === 0 || offers.size === 0 || closed) return
        deliveryTail = deliveryTail.then(async () => {
          while (!closed && pendingOffers.length > 0 && offers.size > 0) {
            const offer = pendingOffers.shift()
            if (offer === undefined) break
            for (const handler of [...offers]) {
              if (isSessionClosed()) break
              await handler(offer)
            }
          }
        }).catch(() => { failSession('task offer handler failed') })
      }
      offMessage = transport.onMessage((frame) => {
        if (closed) return
        if (frame.type === 'auth.accepted') { authenticated = true; resolveAuth(); return }
        if (frame.type === 'error' && !authenticated) { rejectAuth(new ComputeError(frame.code || 'COMPUTE_NODE_AUTH_REJECTED', 401)); return }
        if (frame.type !== 'task.offer') return
        if (!authenticated) { rejectAuth(new ComputeError('COMPUTE_NODE_TASK_BEFORE_AUTH', 401)); return }
        let offer: NodeTaskOfferMessage
        try { offer = parseNodeTaskOffer(frame.offer) } catch {
          // Invalid inbound data is a transport fault; never expose it to an
          // executor. Once authenticated, close the channel so a sender cannot
          // continue feeding an untrusted stream after a malformed frame.
          failSession('invalid task offer')
          return
        }
        if (pendingOffers.length >= options.maxPendingOffers) {
          failSession('pending task offer limit exceeded')
          return
        }
        pendingOffers.push(offer)
        scheduleDelivery()
      })
      offClose = transport.onClose((reason) => {
        closed = true
        pendingOffers.length = 0
        offMessage()
        offClose()
        if (!authenticated) rejectAuth(new ComputeError(reason || 'COMPUTE_NODE_AUTH_CLOSED', 401))
      })
      const timer = setTimeout(() => {
        const error = new ComputeError('COMPUTE_NODE_AUTH_TIMEOUT', 408)
        rejectAuth(error)
        rejectTimeout(error)
      }, options.authTimeoutMs)
      try {
        // `request.accessToken` is passed directly to the transport and is not
        // captured in this connector or returned as part of NodeSession state.
        const sendAuth = Promise.resolve().then(() => {
          if (signal?.aborted) throw abortError()
          return transport.send({ type: 'auth', endpoint: request.endpoint, accessToken: request.accessToken, heartbeat })
        })
        // Observe send and the service's auth response from the same point. If
        // either side fails, the other promise still has a rejection handler,
        // so a late socket failure cannot become an unhandled rejection.
        const handshake = Promise.race([Promise.all([auth, sendAuth]).then(() => undefined), timeout])
        await raceAbort(handshake, signal)
        return {
          sendHeartbeat: async (message) => { ensureOpen(closed); const normalized = parseNodeHeartbeat(message); await transport.send({ type: 'heartbeat', message: normalized }) },
          sendProgress: async (message) => { ensureOpen(closed); validateProgress(message); const normalized = { type: 'task.progress' as const, taskId: message.taskId, attempt: message.attempt, sequence: message.sequence, progress: message.progress, phase: message.phase }; await transport.send({ type: 'task.progress', message: normalized }) },
          sendReturn: async (message) => { ensureOpen(closed); validateReturn(message); const normalized = { type: 'task.return' as const, taskId: message.taskId, attempt: message.attempt, outputs: message.outputs.map(output => ({ name: output.name, bytes: output.bytes, sha256: output.sha256 })) }; await transport.send({ type: 'task.return', message: normalized }) },
          onOffer: (handler) => {
            if (closed) return () => {}
            offers.add(handler)
            scheduleDelivery()
            return () => offers.delete(handler)
          },
          close: async (reason) => {
            if (!closed) {
              closed = true
              pendingOffers.length = 0
              offMessage()
              offClose()
            }
            await deliveryTail
            await transport.close(reason)
          },
        }
      } catch (error) {
        offMessage(); offClose(); closed = true
        try { await transport.close('authentication failed') } catch { /* preserve auth error */ }
        throw error
      } finally { clearTimeout(timer) }
    },
  }
}

function validateConnectRequest(request: NodeConnectRequest): NodeHeartbeatMessage {
  const requestValue: unknown = request
  if (requestValue === null || typeof requestValue !== 'object' || Array.isArray(requestValue)) {
    throw new ComputeError('COMPUTE_NODE_CONNECT_REQUEST_INVALID')
  }
  const item = requestValue as Record<string, unknown>
  if (typeof item.endpoint !== 'string' || item.endpoint.length < 1 || item.endpoint.length > 2048
    || typeof item.accessToken !== 'string' || item.accessToken.length < 1
    || item.accessToken.length > 8192) {
    throw new ComputeError('COMPUTE_NODE_CONNECT_REQUEST_INVALID')
  }
  try { return parseNodeHeartbeat(item.heartbeat) } catch { throw new ComputeError('COMPUTE_NODE_CONNECT_REQUEST_INVALID') }
}

function validateProgress(message: NodeTaskProgressMessage): void {
  const messageValue: unknown = message
  if (messageValue === null || typeof messageValue !== 'object' || Array.isArray(messageValue)) {
    throw new ComputeError('COMPUTE_NODE_PROGRESS_INVALID')
  }
  const item = messageValue as Record<string, unknown>
  if (typeof item.taskId !== 'string' || item.taskId.length < 1
    || typeof item.attempt !== 'number' || !Number.isSafeInteger(item.attempt) || item.attempt < 1
    || typeof item.sequence !== 'number' || !Number.isSafeInteger(item.sequence) || item.sequence < 1
    || typeof item.progress !== 'number' || !Number.isFinite(item.progress) || item.progress < 0 || item.progress > 1
    || typeof item.phase !== 'string' || item.phase.length < 1 || item.phase.length > 128) {
    throw new ComputeError('COMPUTE_NODE_PROGRESS_INVALID')
  }
}

function validateReturn(message: NodeTaskReturnMessage): void {
  const messageValue: unknown = message
  if (messageValue === null || typeof messageValue !== 'object' || Array.isArray(messageValue)) {
    throw new ComputeError('COMPUTE_NODE_RETURN_INVALID')
  }
  const item = messageValue as Record<string, unknown>
  const outputs: unknown = item.outputs
  if (typeof item.taskId !== 'string' || item.taskId.length < 1
    || typeof item.attempt !== 'number' || !Number.isSafeInteger(item.attempt) || item.attempt < 1
    || !Array.isArray(outputs) || outputs.length > 256
    || outputs.some((output: unknown) => !isValidOutput(output))) {
    throw new ComputeError('COMPUTE_NODE_RETURN_INVALID')
  }
}

function isValidOutput(value: unknown): value is { name: string; bytes: number; sha256: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const output = value as Record<string, unknown>
  return typeof output.name === 'string' && output.name.length >= 1 && output.name.length <= 256
    && typeof output.bytes === 'number' && Number.isSafeInteger(output.bytes) && output.bytes >= 0
    && typeof output.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(output.sha256)
}

function ensureOpen(closed: boolean): void { if (closed) throw new ComputeError('COMPUTE_NODE_SESSION_CLOSED', 409) }
function abortError(): Error { return new ComputeError('COMPUTE_NODE_CONNECT_ABORTED', 499) }
async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const abort = () => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      reject(abortError())
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then((value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, (error: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
    if (signal.aborted) abort()
  })
}
