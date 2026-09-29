/** The authenticated transport connector from the phone to the PC session gateway.
 *
 * This file holds no identity, revision or admission logic of its own. It forwards
 * exactly what the phone already decided, and validates exactly what the gateway
 * actually said, so the compact between `PcWindowController` and the host gateway
 * stays the single place where delivery is decided.
 */
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PcWindowBootstrap, PcWindowPort, WindowAccess, WindowBinding, WindowCommand, WindowSyncPage } from './types.ts'
import { parseBinding } from './validation.ts'

/** Gateway path of the access probe. */
const BOOTSTRAP_PATH = '/api/qianshou/mobile/pc-window/bootstrap'
const ACCESS_PATH = '/api/qianshou/mobile/pc-window/access'
/** Gateway path of the command admission endpoint. */
const SUBMIT_PATH = '/api/qianshou/mobile/pc-window/submit'
/** Gateway path of the receipt cursor endpoint. */
const SYNC_PATH = '/api/qianshou/mobile/pc-window/sync'

/** Longest accepted reply body; a hostile or broken gateway must not exhaust the phone. */
const MAX_REPLY_BYTES = 1_048_576

/** Connector settings. */
export interface PcWindowHttpPortOptions {
  /** Origin the phone's authenticated session is already bound to. */
  readonly baseUrl: string
  /** Request deadline in milliseconds; omission leaves the caller's signal in charge. */
  readonly timeoutMs?: number
  /** Fetch implementation; defaults to the ambient one. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * One gateway refusal, carrying the gateway's own code.
 *
 * `mayResend` is true only when the gateway proved the command was never admitted.
 * It defaults to false so an unrecognized failure is treated as an unknown outcome
 * rather than as permission to replay a command onto a real conversation.
 */
export class PcWindowGatewayError extends Error {
  /**
   * @param code - Gateway refusal code, or a connector-local transport code.
   * @param mayResend - Whether the gateway gave explicit non-admission proof.
   */
  constructor(readonly code: string, readonly mayResend = false) {
    super(code)
    this.name = 'PcWindowGatewayError'
  }
}

/** Phone-side connector to the PC session gateway over the authenticated connection. */
export class PcWindowHttpPort implements PcWindowPort {
  private readonly baseUrl: string
  private readonly timeoutMs: number | undefined
  private readonly doFetch: typeof globalThis.fetch

  /** @param options - Gateway origin, optional deadline and fetch implementation. */
  constructor(options: PcWindowHttpPortOptions) {
    // A trailing slash would produce a doubled separator in the request path.
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '')
    this.timeoutMs = options.timeoutMs
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /**
   * Ask the gateway what this origin may do.
   *
   * A refusal that carries an access state is that state; anything else is reported
   * as `unavailable`, because a connector that cannot reach the PC has no evidence
   * that the PC is online.
   * @param binding - Exact origin the phone believes it is authorized for.
   * @param signal - Caller cancellation.
   * @returns The gateway's access verdict.
   */
  /**
   * 换取本机被授权到的源。
   *
   * 手机**不能自己编造**绑定关系（账号 / PC / 会话）——那是网关的权威。这里只把
   * 设备的稳定标识与目标会话送过去，拿回绑定与访问状态，并对两者都做形状校验：
   * 网关返回一个畸形绑定却放行，比拒绝更危险，因为后续所有命令都会绑到错的地方。
   * @param deviceId - 这台手机的稳定设备标识。
   * @param signal - 调用方取消。
   * @param sessionId - 可选的目标会话。
   * @returns 校验过的绑定与访问状态。
   */
  async bootstrap(deviceId: string, signal: AbortSignal, sessionId?: string): Promise<PcWindowBootstrap> {
    const reply = await this.request(BOOTSTRAP_PATH, {
      deviceId,
      ...(sessionId === undefined ? {} : { sessionId }),
    }, signal)
    if (!reply.ok) throw new PcWindowGatewayError(reply.code)
    const value = record(reply.body)
    const binding: WindowBinding = value.binding as WindowBinding
    parseBinding(binding)
    const access = record(value.access)
    const state = access.state
    if (state !== 'online' && state !== 'offline' && state !== 'unauthorized' && state !== 'unavailable') {
      throw new PcWindowGatewayError('PC_WINDOW_INVALID_ACCESS')
    }
    if (!Array.isArray(access.allowedActions)
      || !access.allowedActions.every(action => action === 'dispatch' || action === 'append' || action === 'cancel')) {
      throw new PcWindowGatewayError('PC_WINDOW_INVALID_ACCESS')
    }
    return { binding, access: { state, allowedActions: access.allowedActions } }
  }

  async access(binding: WindowBinding, signal: AbortSignal): Promise<WindowAccess> {
    const reply = await this.request(ACCESS_PATH, { binding }, signal)
    if (!reply.ok) throw new PcWindowGatewayError(reply.code)
    const value = record(reply.body)
    const state = value.state
    if (state !== 'online' && state !== 'offline' && state !== 'unauthorized' && state !== 'unavailable') {
      throw new PcWindowGatewayError('PC_WINDOW_INVALID_ACCESS')
    }
    if (!Array.isArray(value.allowedActions) || !value.allowedActions.every(action => action === 'dispatch' || action === 'append' || action === 'cancel')) {
      throw new PcWindowGatewayError('PC_WINDOW_INVALID_ACCESS')
    }
    return { state, allowedActions: value.allowedActions }
  }

  /**
   * Hand one command to the PC gateway and return its delivery receipt.
   *
   * Only a gateway receipt is returned. A refusal is raised as an error so the
   * controller keeps the command uncertain, which is what stops a phone from
   * showing an unproven command as delivered.
   * @param command - The exact command the phone durably recorded.
   * @param signal - Caller cancellation.
   * @returns The gateway's receipt for this admission.
   */
  async submit(command: WindowCommand, signal: AbortSignal): Promise<unknown> {
    const reply = await this.request(SUBMIT_PATH, { command }, signal)
    if (!reply.ok) {
      const details = refusalDetails(reply.body)
      throw new PcWindowGatewayError(reply.code, details.admitted === false && reply.code === 'PC_WINDOW_SESSION_UNAVAILABLE')
    }
    return record(reply.body).receipt
  }

  /**
   * Read receipts and non-admission proofs after the given cursor.
   * @param binding - Exact origin the cursor belongs to.
   * @param cursor - Last cursor this phone received, or `null` at the stream start.
   * @param requestIds - Commands the phone is actively reconciling.
   * @param signal - Caller cancellation.
   * @returns The gateway's receipt page, unmodified.
   */
  async sync(
    binding: WindowBinding,
    cursor: string | null,
    requestIds: readonly SessionRequestId[],
    signal: AbortSignal,
  ): Promise<unknown> {
    const reply = await this.request(SYNC_PATH, { binding, cursor, requestIds }, signal)
    if (!reply.ok) throw new PcWindowGatewayError(reply.code)
    return reply.body as WindowSyncPage
  }

  /** One JSON round trip with a bounded reply and the caller's cancellation honoured. */
  private async request(path: string, body: unknown, signal: AbortSignal): Promise<
    | { readonly ok: true; readonly body: unknown }
    | { readonly ok: false; readonly code: string; readonly body: unknown }
  > {
    signal.throwIfAborted()
    const controller = new AbortController()
    const timer = this.timeoutMs === undefined ? null : setTimeout(() => { controller.abort() }, this.timeoutMs)
    const relay = (): void => { controller.abort() }
    signal.addEventListener('abort', relay, { once: true })
    try {
      const response = await this.doFetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The phone's cookie is attached by the credentialled transport this call
        // rides on; the connector never reads, stores or forwards a secret itself.
        credentials: 'same-origin',
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      if (new TextEncoder().encode(text).length > MAX_REPLY_BYTES) throw new PcWindowGatewayError('PC_WINDOW_REPLY_TOO_LARGE')
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { throw new PcWindowGatewayError('PC_WINDOW_INVALID_REPLY') }
      if (response.ok) return { ok: true, body: parsed }
      return { ok: false, code: refusalCode(parsed), body: parsed }
    } catch (error) {
      // A caller-driven abort must stay an abort so the controller can discard the
      // generation; every other transport failure is an unknown outcome.
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      if (error instanceof PcWindowGatewayError) throw error
      throw new PcWindowGatewayError('PC_WINDOW_TRANSPORT_FAILED')
    } finally {
      if (timer !== null) clearTimeout(timer)
      signal.removeEventListener('abort', relay)
    }
  }
}

/** Read a gateway refusal code, defaulting to a generic failure. */
function refusalCode(body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error
  if (typeof error !== 'object' || error === null) return 'PC_WINDOW_GATEWAY_REFUSED'
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 && code.length <= 128 ? code : 'PC_WINDOW_GATEWAY_REFUSED'
}

/** Read the bounded details of a refusal, if any. */
function refusalDetails(body: unknown): { readonly admitted?: boolean } {
  const error = (body as { error?: unknown } | null)?.error
  if (typeof error !== 'object' || error === null) return {}
  const details = (error as { details?: unknown }).details
  if (typeof details !== 'object' || details === null) return {}
  const admitted = (details as { admitted?: unknown }).admitted
  return typeof admitted === 'boolean' ? { admitted } : {}
}

/** Require an object reply; a scalar or array is not a gateway envelope. */
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PcWindowGatewayError('PC_WINDOW_INVALID_REPLY')
  return value as Record<string, unknown>
}
