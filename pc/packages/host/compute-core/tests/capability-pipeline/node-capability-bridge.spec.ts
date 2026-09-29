/**
 * 工单 8 · 把管线接到**真实出站投影**上：`node-capability.ts` 的字段面必须能过平台白名单核验。
 *
 * ## 这个测试防的是什么
 *
 * 前面几个 spec 测的是管线自己的判据；本文件测的是**真实节点发出的那个对象**。
 * 只要 `projectNodeCapabilities` 的输出里出现一个平台没声明的键，平台就**无声丢弃**它
 * （`storage/repo.py:1811-1814`）—— `native_bins` 就是这样活了两个月的。
 * 所以这里直接拿真实投影的键集合去跑第 ④ 步的核名，而不是手写一份"我以为是这些键"的清单。
 *
 * ## 两个已知的、被登记过的客户端专属键
 *
 * `mode` / `uptime_sec` 是**已知的有意分歧**，登记在
 * `tests/node-capability-contract.spec.ts` 的 `KNOWN_CLIENT_ONLY_KEYS`。本文件把它们也当成
 * **必须出现的两条丢弃**来断言：这样"平台会丢这两个"这件事既不会被悄悄修好，也不会长出第三个。
 */
import { describe, expect, it } from 'vitest'
import { projectNodeCapabilities } from '../../src/node-capability.ts'
import { checkDeclarationNames, checkOutboundFields, localRegistryMirror } from '../../src/capability-pipeline/registry-mirror.ts'
import type { SupplyProbeResult } from '../../src/supply/types.ts'

const mirror = localRegistryMirror({ now: new Date('2026-09-22T00:00:00.000Z') })

/** 一台真装了 ffmpeg 的机器（`verification: 'verified'` 来自真实的版本探测）。 */
const probe: SupplyProbeResult = {
  hardware: {
    platform: 'darwin',
    arch: 'arm64',
    cpuModel: 'Apple M4',
    logicalCores: 10,
    totalMemoryBytes: 17_179_869_184,
    freeMemoryBytes: 2_000_000_000,
    gpus: [{ name: 'Apple M4', vendor: 'sppci_vendor_Apple', memoryBytes: null }],
    probeErrors: [],
  },
  localServices: [
    { id: 'ffmpeg', kind: 'tool', name: 'ffmpeg', version: '6.0', verification: 'verified', reason: null },
    { id: 'ffprobe', kind: 'tool', name: 'ffprobe', version: '6.0', verification: 'verified', reason: null },
  ],
  activity: { idleSeconds: 12, foregroundTaskActive: false, voiceActive: false },
}

describe('真实投影的字段面必须过第 ④ 步核名', () => {
  it('平台会丢的键恰好是登记过的 mode / uptime_sec 两个，且没有别的拼错', () => {
    const profile = projectNodeCapabilities(probe)
    const drops = checkOutboundFields(Object.keys(profile), mirror)
    expect(drops.map(drop => drop.key)).toEqual(['mode', 'uptime_sec'])
    // 这两个是"平台确实不认、我们知道它不认"的键，不该被当成拼写错误而给出建议。
    expect(drops.every(drop => drop.suggestion === null)).toBe(true)
    expect(drops.every(drop => drop.reason === 'NOT_DECLARED_BY_PLATFORM_WHITELIST')).toBe(true)
  })

  it('native_binaries 是写对的那个名字：整份投影里不含 native_bins', () => {
    const profile = projectNodeCapabilities(probe)
    const keys = Object.keys(profile)
    expect(keys).toContain('native_binaries')
    expect(keys).not.toContain('native_bins')
    expect(checkOutboundFields(['native_bins'], mirror)[0]?.suggestion).toBe('native_binaries')
  })
})

describe('管线是广告面的唯一权威：给了批准清单就不再按软件名自己推断', () => {
  it('不给批准清单时保持旧行为（按软件名推断），双写不破坏现有路径', () => {
    const profile = projectNodeCapabilities(probe)
    expect(profile.provided_capabilities.map(ad => ad.name)).toEqual([
      'audio.extract',
      'audio.transcode',
      'media.probe',
      'media.thumbnail',
      'media.transcode',
    ])
  })

  it('给了批准清单 ⇒ 出站广告面就是它，装了 ffmpeg 也不再自动多报 5 项', () => {
    const profile = projectNodeCapabilities(probe, {
      providedCapabilities: [{ name: 'text.transform', version: '1.0', health: 'ok' }],
    })
    expect(profile.provided_capabilities).toEqual([{ name: 'text.transform', version: '1.0', health: 'ok' }])
    // 软件清单（平台 planner 硬过滤读的那个字段）不受影响，仍是如实探测结果。
    expect(profile.software).toEqual(['ffmpeg', 'ffprobe'])
    expect(profile.native_binaries).toEqual(['ffmpeg', 'ffprobe'])
  })

  it('批准清单为空 ⇒ 广告面为空（"没通过管线"就等于"什么都不报"，不许回退成自己推断）', () => {
    const profile = projectNodeCapabilities(probe, { providedCapabilities: [] })
    expect(profile.provided_capabilities).toEqual([])
  })

  it('纵深防御：非契约名在投影处被挡掉，且这是第二道网而不是可见性出口（名字合法性由第 ④ 步点名）', () => {
    const profile = projectNodeCapabilities(probe, {
      providedCapabilities: [
        { name: 'text.transform', version: '1.0', health: 'ok' },
        { name: 'word_count', version: '1.0', health: 'ok' },
        { name: 'ffmpeg', version: '1.0', health: 'ok' },
      ] as never,
    })
    expect(profile.provided_capabilities.map(ad => ad.name)).toEqual(['text.transform'])
    // 这两个名字在管线第 ④ 步一样会被点名，所以这里的过滤不会造成"没人知道它被丢了"。
    expect(checkDeclarationNames(['word_count'], mirror)[0]?.reason).toBe('LEGACY_TASK_TYPE_NAME')
    const ffmpeg = checkDeclarationNames(['ffmpeg'], mirror)[0]
    expect(ffmpeg?.reason).toBe('IMPLEMENTATION_NAME_NOT_A_CAPABILITY')
    // ffmpeg 一项覆盖 5 个契约能力 ⇒ 不给"选一个"的建议，而是把它们全列出来。
    expect(ffmpeg?.suggestion).toBeNull()
    expect(ffmpeg?.detail).toContain('media.transcode')
  })
})
