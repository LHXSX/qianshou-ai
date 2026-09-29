/** Owner-authenticated PC session gateway routes on the existing Connection carrier.
 *
 * These routes sit below `/api`, so the carrier has already applied its Host fence
 * and browser authentication before any handler runs. No handler here re-implements
 * authentication, accepts a non-loopback Host, or trusts a body to name its own
 * account: the origin in the body is only ever matched against a host-authorized
 * binding that this process created.
 */
import type { Context } from '@deepseek-ai/cordis'
import { MobileSyncError } from '../errors.ts'
import type { PcWindowGateway } from './service.ts'

/** Register the bounded PC-window gateway surface.
 * @param ctx - Existing authenticated Connection scope.
 * @param gateway - Plugin-owned durable command gateway.
 * @param maxRequestBytes - Additional local JSON limit under the carrier's transport limit.
 */
export function registerGatewayRoutes(
  ctx: Context,
  gateway: PcWindowGateway,
  maxRequestBytes: number,
  /**
   * 引导（配对）所需的宿主能力。
   *
   * `pairing` 是**闸门**：没有它，任何能调到这条路由的页面都能给自己发一个绑定，
   * 而「手机不能自己授权自己」正是当初把 `registerBinding` 留在 host 侧程序化 API、
   * 不暴露成 HTTP 的原因。票据由人在电脑上发起（显示成二维码），手机凭票换取绑定。
   *
   * `accountId` 是**身份对齐**的落点：绑定的 `accountId` 必须取真实登录账号，
   * 而不是一个占位字符串——否则跨设备会把两台机器当成两个人。
   */
  pairing: {
    readonly redeem: (ticket: string, source: string) => { readonly ok: boolean; readonly reason?: string }
    /** 当前登录账号的 id；未登录返回 `null`。 */
    readonly accountId: () => Promise<string | null>
    /** 这台电脑的稳定标识（绑定里的 `pcId`）。 */
    readonly pcId: () => string
    /** 这台电脑当前打开的会话 id；没有则返回 `null`。 */
    readonly sessionId: () => string | null
  },
): void {
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
  /** Project one refusal without leaking internals; details stay bounded and typed. */
  const failure = (error: unknown): Response => {
    const refusal = error instanceof MobileSyncError ? error : new MobileSyncError('MOBILE_SYNC_FAILED', 502)
    return response({
      error: {
        code: refusal.code,
        message: refusal.code,
        ...(Object.keys(refusal.details).length === 0 ? {} : { details: refusal.details }),
      },
    }, refusal.status)
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/mobile/pc-window/access', methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const payload = await body(request)
        return response(await gateway.access(payload.binding))
      } catch (error) { return failure(error) }
    },
  }), 'mobile-sync: POST /api/qianshou/mobile/pc-window/access')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/mobile/pc-window/bootstrap', methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const payload = await body(request)
        const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : ''
        const ticket = typeof payload.ticket === 'string' ? payload.ticket : ''
        if (deviceId.length === 0) throw new MobileSyncError('PC_WINDOW_BOOTSTRAP_DEVICE_REQUIRED', 400)

        // 闸门一：必须有票。扫码这件事本身就是「人在电脑前授权」，票是它的凭证。
        const redeemed = pairing.redeem(ticket, deviceId)
        if (!redeemed.ok) {
          // 三类失败分开回：拿错票、票过期、撞太多次，用户的处置完全不同。
          const code = redeemed.reason === 'too-many-attempts'
            ? 'PC_WINDOW_PAIR_TOO_MANY_ATTEMPTS'
            : redeemed.reason === 'expired' ? 'PC_WINDOW_PAIR_EXPIRED' : 'PC_WINDOW_PAIR_UNKNOWN'
          throw new MobileSyncError(code, 403)
        }

        // 闸门二：必须已登录。绑定的 accountId 取自**真实账号**，不编占位值。
        const accountId = await pairing.accountId()
        if (accountId === null) throw new MobileSyncError('PC_WINDOW_NOT_SIGNED_IN', 401)

        const sessionId = pairing.sessionId()
        if (sessionId === null) throw new MobileSyncError('PC_WINDOW_NO_SESSION', 409)

        const binding = { accountId, pcId: pairing.pcId(), sessionId, sourceDeviceId: deviceId }
        await gateway.registerBinding(binding)
        return response({ binding, access: await gateway.access(binding) })
      } catch (error) { return failure(error) }
    },
  }), 'mobile-sync: POST /api/qianshou/mobile/pc-window/bootstrap')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/mobile/pc-window/submit', methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const payload = await body(request)
        // The receipt is the only success shape: a gateway that cannot prove
        // admission answers with an error status, never with a filled-in receipt.
        return response(await gateway.submit(payload.command))
      } catch (error) { return failure(error) }
    },
  }), 'mobile-sync: POST /api/qianshou/mobile/pc-window/submit')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/mobile/pc-window/sync', methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const payload = await body(request)
        return response(await gateway.sync(payload.binding, payload.cursor ?? null, payload.requestIds))
      } catch (error) { return failure(error) }
    },
  }), 'mobile-sync: POST /api/qianshou/mobile/pc-window/sync')
}
