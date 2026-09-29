/**
 * 第一道门的测试：地址解析、来源判定、白名单决策。
 *
 * 这一组测试的写法是"**逐条钉住失效模式**"而不是"跑一遍看看"：
 * 每一条断言对应一种真实的绕过或误挡（前导零写法、v4-mapped 表示法、
 * 伪造代理头、空白名单、非法 CIDR）。
 */
import { describe, expect, it } from 'vitest'
import { cidrContains, isLoopback, parseAddress, parseCidr } from '../src/cidr.ts'
import { resolveClientAddress } from '../src/client-ip.ts'
import { decideWhitelist, emptyWhitelist, isValidRule, type WhitelistConfig } from '../src/whitelist.ts'

/** 造一个请求头读取器。 */
function headersOf(map: Record<string, string>): (name: string) => string | null {
  return name => map[name.toLowerCase()] ?? null
}

describe('地址解析', () => {
  it('解析 IPv4 与 CIDR', () => {
    expect(parseAddress('127.0.0.1')).toEqual({ family: 4, segments: [127, 0, 0, 1] })
    expect(parseCidr('10.0.0.0/8')).toEqual({ family: 4, segments: [10, 0, 0, 0], prefix: 8 })
    // 裸地址按 /32 处理。
    expect(parseCidr('203.0.113.7')).toEqual({ family: 4, segments: [203, 0, 113, 7], prefix: 32 })
  })

  it('拒绝前导零与越界段（前导零在不同解析器里含义不同，是经典绕过手法）', () => {
    expect(parseAddress('010.0.0.1')).toBeNull()
    expect(parseAddress('256.0.0.1')).toBeNull()
    expect(parseAddress('1.2.3')).toBeNull()
    expect(parseAddress('1.2.3.4.5')).toBeNull()
  })

  it('解析 IPv6（含压缩与内嵌 IPv4）', () => {
    expect(parseAddress('::1')).toEqual({ family: 6, segments: [0, 0, 0, 0, 0, 0, 0, 1] })
    expect(parseCidr('2001:db8::/32')).not.toBeNull()
    // v4-mapped 必须与 IPv4 等价，否则同一个人换个写法就能绕过（或被误挡）。
    expect(parseAddress('::ffff:127.0.0.1')).toEqual({ family: 4, segments: [127, 0, 0, 1] })
    expect(parseAddress('::ffff:10.0.0.1')).toEqual({ family: 4, segments: [10, 0, 0, 1] })
  })

  it('拒绝非法 IPv6', () => {
    expect(parseAddress('::1::2')).toBeNull()
    expect(parseCidr('2001:db8::/129')).toBeNull()
    expect(parseCidr('10.0.0.0/33')).toBeNull()
    expect(parseCidr('abc/8')).toBeNull()
  })

  it('CIDR 匹配按位判定（边界值必须精确）', () => {
    expect(cidrContains('203.0.113.7', '203.0.113.0/24')).toBe(true)
    expect(cidrContains('203.0.114.7', '203.0.113.0/24')).toBe(false)
    expect(cidrContains('203.0.113.7', '203.0.113.7/32')).toBe(true)
    expect(cidrContains('203.0.113.8', '203.0.113.7/32')).toBe(false)
    // /0 覆盖全部 IPv4 —— 合法但极端，必须能表达。
    expect(cidrContains('8.8.8.8', '0.0.0.0/0')).toBe(true)
    // 非法规则一律不匹配（fail-closed）。
    expect(cidrContains('203.0.113.7', 'not-a-rule')).toBe(false)
    expect(cidrContains('', '203.0.113.0/24')).toBe(false)
  })

  it('回环判定覆盖 IPv4 与 IPv6，且不把 128 段误判', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopback('128.0.0.1')).toBe(false)
    expect(isLoopback('10.0.0.1')).toBe(false)
    expect(isLoopback('')).toBe(false)
  })

  it('isValidRule 只认能解析的写法', () => {
    expect(isValidRule('203.0.113.7/32')).toBe(true)
    expect(isValidRule('203.0.113.7')).toBe(true)
    expect(isValidRule('203.0.113.7/33')).toBe(false)
    expect(isValidRule('随便写的')).toBe(false)
  })
})

describe('来源地址判定（不能由客户端说了算）', () => {
  it('回环 + 代理头 → 采信 X-Real-IP（这是 nginx 在用的形态）', () => {
    const address = resolveClientAddress('127.0.0.1', headersOf({ 'x-real-ip': '203.0.113.7' }), true)
    expect(address).toEqual({ ip: '203.0.113.7', source: 'x-real-ip' })
  })

  it('回环但没有代理头 → 用 socket（SSH 里 curl 的逃生路径）', () => {
    expect(resolveClientAddress('127.0.0.1', headersOf({}), true)).toEqual({ ip: '127.0.0.1', source: 'socket' })
  })

  it('**非回环连接一律忽略代理头**（否则任何人都能自称白名单内）', () => {
    const address = resolveClientAddress('198.51.100.9', headersOf({ 'x-real-ip': '203.0.113.7' }), true)
    expect(address).toEqual({ ip: '198.51.100.9', source: 'socket' })
  })

  it('没有 X-Real-IP 时取 X-Forwarded-For 的**最后**一项', () => {
    const address = resolveClientAddress(
      '::ffff:127.0.0.1',
      headersOf({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }),
      true,
    )
    expect(address).toEqual({ ip: '203.0.113.7', source: 'x-forwarded-for' })
  })

  it('trustProxy 关闭时连回环也不看头', () => {
    expect(resolveClientAddress('127.0.0.1', headersOf({ 'x-real-ip': '203.0.113.7' }), false))
      .toEqual({ ip: '127.0.0.1', source: 'socket' })
  })

  it('地址读不出来时如实标 unknown，而不是当成本机', () => {
    expect(resolveClientAddress(undefined, headersOf({}), true).ip).toBe('unknown')
  })
})

describe('白名单决策（默认拒绝）', () => {
  const entry = (cidr: string): WhitelistConfig['entries'][number] => ({ cidr, note: '', addedBy: 'test', addedAt: 0 })

  it('空白名单 = 谁都不许进，但回环永远放行（逃生路径）', () => {
    const config = emptyWhitelist()
    expect(decideWhitelist('203.0.113.7', config)).toEqual({ allowed: false, reason: 'empty', matched: null })
    expect(decideWhitelist('127.0.0.1', config)).toEqual({ allowed: true, reason: 'loopback', matched: null })
    expect(decideWhitelist('::1', config)).toEqual({ allowed: true, reason: 'loopback', matched: null })
  })

  it('命中条目才放行；命中哪一条要能说出来（审计里要写）', () => {
    const config: WhitelistConfig = { enabled: true, entries: [entry('203.0.113.0/24')] }
    expect(decideWhitelist('203.0.113.7', config)).toEqual({ allowed: true, reason: 'match:203.0.113.0/24', matched: '203.0.113.0/24' })
    expect(decideWhitelist('198.51.100.7', config)).toEqual({ allowed: false, reason: 'no-match', matched: null })
  })

  it('非法条目被忽略，不会因为"有条目"就放行', () => {
    const config: WhitelistConfig = { enabled: true, entries: [entry('乱写的')] }
    expect(decideWhitelist('203.0.113.7', config).allowed).toBe(false)
  })

  it('只有显式关闭才允许所有来源（灾难恢复开关，默认不开）', () => {
    const config: WhitelistConfig = { enabled: false, entries: [] }
    expect(decideWhitelist('203.0.113.7', config)).toEqual({ allowed: true, reason: 'disabled', matched: null })
    expect(emptyWhitelist().enabled).toBe(true)
  })
})
