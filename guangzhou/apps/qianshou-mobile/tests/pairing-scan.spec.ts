/**
 * 扫码的环境判定测试。
 *
 * 重点在**区分失败原因**：协议不对（要换 https）、浏览器不支持（可以手输）、
 * 没权限（去设置里开）——用户要做的事完全不同，合成一句「扫码失败」等于什么都没说。
 */
import { describe, expect, it } from 'vitest'
import { SCAN_COPY, scanSupport } from '../src/pairing.ts'

describe('能不能扫码', () => {
  it('HTTPS + 摄像头接口 + 原生识别器 = 可以', () => {
    expect(scanSupport({ isSecureContext: true, mediaDevices: {}, barcodeDetector: () => {} }))
      .toEqual({ ok: true, reason: null })
  })

  it('http 下即使接口都在，也要报「协议不对」而不是「不支持」', () => {
    // 这是最容易被写成误导的一条：http 下 getUserMedia 会直接失败，
    // 但真实原因是安全上下文，处置是「换 https」，不是「换浏览器」。
    const support = scanSupport({ isSecureContext: false, mediaDevices: {}, barcodeDetector: () => {} })
    expect(support.ok).toBe(false)
    expect(support.reason).toBe('insecure-context')
    expect(SCAN_COPY['insecure-context']).toContain('https')
  })

  it('没有摄像头接口：报不支持，并给出替代路径', () => {
    const support = scanSupport({ isSecureContext: true, mediaDevices: undefined, barcodeDetector: () => {} })
    expect(support.reason).toBe('unsupported')
    expect(SCAN_COPY.unsupported).toContain('手动输入')
  })

  it('没有原生识别器：同样报不支持（不为它引一个扫码库）', () => {
    const support = scanSupport({ isSecureContext: true, mediaDevices: {}, barcodeDetector: undefined })
    expect(support.reason).toBe('unsupported')
  })

  it('每种失败原因都有面向用户的说明，且互不重复', () => {
    const kinds = ['insecure-context', 'unsupported', 'denied', 'no-camera', 'busy'] as const
    const texts = kinds.map(kind => SCAN_COPY[kind])
    for (const text of texts) expect(text.length).toBeGreaterThan(0)
    expect(new Set(texts).size).toBe(kinds.length)
  })
})
