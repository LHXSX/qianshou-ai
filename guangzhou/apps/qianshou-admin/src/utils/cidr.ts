/**
 * 纯展示用的 IPv4 CIDR 覆盖判断。
 *
 * 只用于给「当前出口是否被某条白名单覆盖」打标记；
 * **不参与任何访问控制**（白名单是服务端的第一道门，前端不做判断）。
 * IPv6 / 非 IPv4 输入一律返回 false，而不是猜测。
 */

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = value * 256 + octet
  }
  return value
}

/** `cidr` 是否覆盖 `ip`（仅 IPv4；无法判断时返回 false）。 */
export function cidrContainsIp(cidr: string, ip: string): boolean {
  const [network, prefixText] = cidr.split('/')
  if (network === undefined || network === '') return false
  const prefix = prefixText === undefined ? 32 : Number(prefixText)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  const networkInt = ipv4ToInt(network)
  const ipInt = ipv4ToInt(ip)
  if (networkInt === undefined || ipInt === undefined) return false
  if (prefix === 0) return true
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return ((networkInt & mask) >>> 0) === ((ipInt & mask) >>> 0)
}
