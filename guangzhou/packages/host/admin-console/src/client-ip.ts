/**
 * 「这次请求到底来自哪个 IP」——白名单判定的输入。
 *
 * 这件事有一个**必须做对**的点：来源地址不能由客户端说了算。
 *
 * 我们的部署形状是 nginx（公网 443）→ 本服务（只监听 127.0.0.1:7090）。
 * 于是：
 * - 走公网的请求，socket 对端永远是 `127.0.0.1`，真实来源只在 nginx 写的
 *   `X-Real-IP`（`proxy_set_header X-Real-IP $remote_addr`，**nginx 会覆盖**客户端
 *   自己带的同名头）里；
 * - 本机直接访问（SSH 里 curl 127.0.0.1:7090）没有这些头，来源就是 socket 对端。
 *
 * 所以判据是「**只有 socket 对端是本机回环时，才采信代理头**」：
 * 非回环连接（比如将来把端口直接暴露出去）一律用 socket 地址，客户端伪造的头被完全忽略。
 *
 * 已知边界（写在明处，不当成不存在）：能在本机发起请求的进程可以伪造 `X-Real-IP`
 * 让自己"看起来"在白名单里。那种进程本来就能改本机的白名单文件、读本机的数据，
 * 已经不是这套判定的防线能覆盖的对象。
 */
import { isLoopback, parseAddress } from './cidr.ts'

/** 取值结果：地址 + 它是怎么来的（审计里要能看出判据）。 */
export interface ClientAddress {
  /** 判定用的来源地址（已归一化的文本形式）。 */
  readonly ip: string
  /** `socket` = 直连对端；`x-real-ip` = 受信代理写的真实来源；`x-forwarded-for` = 代理链最后一个值。 */
  readonly source: 'socket' | 'x-real-ip' | 'x-forwarded-for'
}

/** 取请求头（大小写不敏感）。 */
type HeaderReader = (name: string) => string | null | undefined

/** 归一化：能解析就返回标准文本，解析不了原样返回（避免把 `::ffff:1.2.3.4` 当成另一个地址）。 */
function normalize(ip: string): string {
  return ip.trim()
}

/**
 * 解析来源地址。
 * @param remoteAddress - socket 对端地址（`req.socket.remoteAddress`，可能是 `::ffff:127.0.0.1`）。
 * @param headers - 请求头读取器。
 * @param trustProxy - 是否采信代理头；部署在 nginx 之后为 `true`。
 * @returns 判定用的地址与来源说明。
 */
export function resolveClientAddress(
  remoteAddress: string | undefined,
  headers: HeaderReader,
  trustProxy: boolean,
): ClientAddress {
  const socket = normalize(remoteAddress ?? '')
  // `::ffff:127.0.0.1` 是 IPv4 映射写法，必须与 `127.0.0.1` 等价（isLoopback 里已归一化）。
  const socketIsLoopback = socket.length > 0 && isLoopback(socket)
  if (!trustProxy || !socketIsLoopback) {
    return { ip: socket.length > 0 ? socket : 'unknown', source: 'socket' }
  }

  const realIp = headers('x-real-ip')
  if (typeof realIp === 'string' && realIp.trim().length > 0) {
    const candidate = normalize(realIp)
    if (parseAddress(candidate) !== null) return { ip: candidate, source: 'x-real-ip' }
  }

  const forwarded = headers('x-forwarded-for')
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    // 取**最后一个**值：那是与本次连接相邻的代理看见的来源；取第一个等于把
    // 客户端可伪造的那一段当依据（nginx 的 `$proxy_add_x_forwarded_for` 会把
    // 客户端自带的头追加在前面）。
    const parts = forwarded.split(',').map(part => part.trim()).filter(part => part.length > 0)
    const candidate = parts[parts.length - 1]
    if (candidate !== undefined && parseAddress(candidate) !== null) {
      return { ip: candidate, source: 'x-forwarded-for' }
    }
  }

  return { ip: socket, source: 'socket' }
}
