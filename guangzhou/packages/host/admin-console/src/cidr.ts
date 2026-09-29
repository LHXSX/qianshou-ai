/**
 * IP 与 CIDR 的判定。
 *
 * 为什么自己写而不是引一个包：这是**管理台的第一道门**（默认拒绝一切），
 * 而白名单逻辑的失效模式是"悄悄放行"——它必须在测试里被逐条钉住，
 * 也必须能被读懂。引入第三方实现的收益是一个几百行的解析器，
 * 代价是把安全边界交给一个我们不会去读的依赖。
 *
 * 支持范围：IPv4 与 IPv6（含 `::` 压缩、内嵌 IPv4、`::ffff:1.2.3.4` 映射地址）。
 * 不做的：不做 DNS 解析（主机名白名单会被 DNS 投毒绕开）、不做通配符。
 */

/** 一个已解析的地址：4 段（IPv4）或 8 段（IPv6），每段 0..65535（IPv4 段 0..255）。 */
export interface ParsedAddress {
  /** 4 = IPv4，6 = IPv6。 */
  readonly family: 4 | 6
  /** 大端顺序的段值。 */
  readonly segments: readonly number[]
}

/** 把 IPv4 字符串解析成 4 段；不合法返回 `null`。 */
function parseIpv4(text: string): readonly number[] | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const part of parts) {
    // 只认十进制且没有前导零：`010` 在不同解析器里可能是 8 也可能是 10，
    // 这种歧义正是绕过白名单的经典手法。
    if (!/^\d{1,3}$/.test(part)) return null
    if (part.length > 1 && part.startsWith('0')) return null
    const value = Number(part)
    if (value > 255) return null
    out.push(value)
  }
  return out
}

/** 把 IPv6 字符串解析成 8 段；不合法返回 `null`。 */
function parseIpv6(text: string): readonly number[] | null {
  if (text.length === 0) return null
  // 内嵌 IPv4（`::ffff:127.0.0.1`）：先把尾巴换成两段十六进制。
  let normalized = text
  const lastColon = normalized.lastIndexOf(':')
  if (lastColon !== -1 && normalized.slice(lastColon + 1).includes('.')) {
    const embedded = parseIpv4(normalized.slice(lastColon + 1))
    if (embedded === null) return null
    const high = ((embedded[0] as number) << 8) | (embedded[1] as number)
    const low = ((embedded[2] as number) << 8) | (embedded[3] as number)
    normalized = `${normalized.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`
  }
  const doubleColon = normalized.indexOf('::')
  if (doubleColon !== normalized.lastIndexOf('::')) return null

  const toSegments = (chunk: string): number[] | null => {
    if (chunk.length === 0) return []
    const out: number[] = []
    for (const part of chunk.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
      out.push(parseInt(part, 16))
    }
    return out
  }

  if (doubleColon === -1) {
    const segments = toSegments(normalized)
    return segments !== null && segments.length === 8 ? segments : null
  }
  const headText = normalized.slice(0, doubleColon)
  const tailText = normalized.slice(doubleColon + 2)
  const head = toSegments(headText)
  const tail = toSegments(tailText)
  if (head === null || tail === null) return null
  const missing = 8 - head.length - tail.length
  // `::` 至少要展开一段；`1:2:3:4:5:6:7:8::` 这种写法非法。
  if (missing < 1) return null
  return [...head, ...new Array<number>(missing).fill(0), ...tail]
}

/**
 * 解析一个地址（不带前缀长度）。
 * @param text - 例如 `127.0.0.1`、`::1`、`::ffff:10.0.0.1`。
 * @returns 解析结果；不合法返回 `null`。
 */
export function parseAddress(text: string): ParsedAddress | null {
  const trimmed = text.trim()
  if (trimmed.includes(':')) {
    const segments = parseIpv6(trimmed)
    if (segments === null) return null
    // 归一化 v4-mapped：`::ffff:1.2.3.4` 与 `1.2.3.4` 必须等价，否则同一个人
    // 换个表示法就能绕过（或被误挡）白名单。
    const [s0, s1, s2, s3, s4, s5, s6, s7] = segments as [
      number, number, number, number, number, number, number, number,
    ]
    if (s0 === 0 && s1 === 0 && s2 === 0 && s3 === 0 && s4 === 0 && s5 === 0xffff) {
      return { family: 4, segments: [s6 >> 8, s6 & 0xff, s7 >> 8, s7 & 0xff] }
    }
    return { family: 6, segments }
  }
  const segments = parseIpv4(trimmed)
  return segments === null ? null : { family: 4, segments }
}

/** 已解析的 CIDR。 */
export interface ParsedCidr {
  readonly family: 4 | 6
  readonly segments: readonly number[]
  /** 前缀长度（IPv4 0..32，IPv6 0..128）。 */
  readonly prefix: number
}

/**
 * 解析 CIDR（`10.0.0.0/8`）或裸地址（按 /32、/128 处理）。
 * @param text - 白名单条目原文。
 * @returns 解析结果；不合法返回 `null`。
 */
export function parseCidr(text: string): ParsedCidr | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const slash = trimmed.lastIndexOf('/')
  if (slash === -1) {
    const address = parseAddress(trimmed)
    if (address === null) return null
    return { family: address.family, segments: address.segments, prefix: address.family === 4 ? 32 : 128 }
  }
  const address = parseAddress(trimmed.slice(0, slash))
  if (address === null) return null
  const prefixText = trimmed.slice(slash + 1)
  if (!/^\d{1,3}$/.test(prefixText)) return null
  const prefix = Number(prefixText)
  const max = address.family === 4 ? 32 : 128
  if (prefix > max) return null
  return { family: address.family, segments: address.segments, prefix }
}

/** 把地址按前缀长度掩码后比较前 `prefix` 位。 */
function samePrefix(left: ParsedAddress, right: ParsedCidr): boolean {
  if (left.family !== right.family) return false
  const bitsPerSegment = left.family === 4 ? 8 : 16
  let remaining = right.prefix
  for (let index = 0; index < left.segments.length; index += 1) {
    const value = left.segments[index] as number
    const mask = right.segments[index] as number
    if (remaining <= 0) return true
    if (remaining >= bitsPerSegment) {
      if (value !== mask) return false
      remaining -= bitsPerSegment
      continue
    }
    const shift = bitsPerSegment - remaining
    return (value >> shift) === (mask >> shift)
  }
  return true
}

/**
 * 判断一个地址是否落在某条白名单规则里。
 * @param ip - 待判定的来源地址（可以是裸地址或 CIDR 形式，CIDR 只取其地址部分）。
 * @param rule - 白名单条目。
 * @returns 命中返回 `true`；任意一侧解析失败一律 `false`（fail-closed）。
 */
export function cidrContains(ip: string, rule: string): boolean {
  const address = parseAddress(ip.split('/')[0] ?? '')
  const cidr = parseCidr(rule)
  if (address === null || cidr === null) return false
  return samePrefix(address, cidr)
}

/** 这个地址是不是本机回环（逃生路径的判据）。 */
export function isLoopback(ip: string): boolean {
  const address = parseAddress(ip.split('/')[0] ?? '')
  if (address === null) return false
  if (address.family === 4) return (address.segments[0] as number) === 127
  const segments = address.segments
  return segments.slice(0, 7).every(value => value === 0) && (segments[7] as number) === 1
}
