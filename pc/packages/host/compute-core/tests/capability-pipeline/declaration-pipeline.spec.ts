/**
 * 工单 8 · 六步管线的端到端验收（**先红后绿**的五条判据都在这一个文件里）。
 *
 * 判据 → 用例对照：
 * 1. 未映射项 ⇒ 出现在未映射清单（`contract-map.spec.ts` + 本文件的跨步用例）
 * 2. 故意用 `native_bins` / 旧式裸名 ⇒ **可见告警 + 进差集**（两次真实事故的回归闸）
 * 3. 假健康 ⇒ 不进候选
 * 4. 声明 3 项、平台只认 2 项 ⇒ 差集显示被丢的那项**及原因**
 * 5. 全自动档下白名单外能力**不得自动开**
 */
import { describe, expect, it } from 'vitest'
import {
  runCapabilityDeclarationPipeline,
  renderCapabilityDeclarationReport,
  applyCapabilitySuggestion,
  scoutCapabilitySuggestions,
} from '../../src/capability-pipeline/pipeline.ts'
import { localRegistryMirror } from '../../src/capability-pipeline/registry-mirror.ts'
import { defaultOwnerCapabilityPolicy } from '../../src/capability-pipeline/owner-approval.ts'
import type { CapabilityProbeOutcome, CapabilityProbePort } from '../../src/capability-pipeline/health-probe.ts'
import type { LocalCapabilityItem } from '../../src/capability-pipeline/contract-map.ts'
import type { OwnerCapabilityApprovalPolicy } from '../../src/capability-pipeline/owner-approval.ts'

const mirror = localRegistryMirror({ now: new Date('2026-09-22T00:00:00.000Z') })

/** 端口：列出的能力真跑一遍通过，没列出的记为"没有执行器绑定"。 */
function port(healthy: readonly string[], overrides: Readonly<Record<string, CapabilityProbeOutcome>> = {}): CapabilityProbePort {
  const ok = new Set(healthy)
  return {
    invoke: async (capability: string): Promise<CapabilityProbeOutcome> => {
      const override = overrides[capability]
      if (override !== undefined) return override
      if (ok.has(capability)) return { invoked: true, ok: true, detail: `${capability} 最小调用通过` }
      return { invoked: true, ok: false, reason: 'NO_EXECUTOR_BOUND', detail: `${capability} 没有绑定的执行器` }
    },
  }
}

function policy(overrides: Partial<OwnerCapabilityApprovalPolicy> = {}): OwnerCapabilityApprovalPolicy {
  return { ...defaultOwnerCapabilityPolicy(), ...overrides }
}

describe('④ 差集可见化（本工单最重要）：声明 3 项、平台只认 2 项', () => {
  const items: readonly LocalCapabilityItem[] = [
    { id: 'numpy', kind: 'package' },
    { id: 'film-host', kind: 'workflow', capability: 'media.compose' },
    { id: 'word-runner', kind: 'workflow', capability: 'text.transform' },
  ]
  const threeWays = policy({
    defaultTier: 'auto',
    autoWhitelist: ['compute.numeric', 'media.compose', 'text.transform'],
    // media.compose 涉文件，即便在白名单里也必须主人逐条确认过（见 ⑤ 的硬边界）。
    confirmed: ['media.compose'],
  })

  it('本机 3 项经管线变成 3 条出站声明', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items, mirror, health: port(['compute.numeric', 'media.compose', 'text.transform']),
      ownerPolicy: threeWays, acknowledged: ['compute.numeric', 'media.compose', 'text.transform'],
      outboundFields: ['os', 'arch', 'provided_capabilities'],
    })
    expect(report.outbound.map(ad => ad.name)).toEqual(['compute.numeric', 'media.compose', 'text.transform'])
    expect(report.outbound.every(ad => ad.health === 'ok' && ad.version === '1.0')).toBe(true)
    expect(report.difference.empty).toBe(true)
    expect(report.requiresOwnerAttention).toBe(false)
  })

  it('平台只承认 2 项 ⇒ 被丢的那一项必须同时出现在差集、告警和主人可读文本里，并带原因', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items, mirror, health: port(['compute.numeric', 'media.compose', 'text.transform']),
      ownerPolicy: threeWays, acknowledged: ['compute.numeric', 'media.compose'],
      outboundFields: ['os'],
    })

    expect(report.difference.declared).toEqual(['compute.numeric', 'media.compose', 'text.transform'])
    expect(report.difference.acknowledged).toEqual(['compute.numeric', 'media.compose'])
    expect(report.difference.dropped).toEqual([
      {
        name: 'text.transform',
        stage: 'platform',
        reason: 'PLATFORM_DID_NOT_ACKNOWLEDGE',
        detail: expect.stringContaining('hello_union_gate'),
      },
    ])
    expect(report.requiresOwnerAttention).toBe(true)
    // 差集非空 ⇒ 主人一定能看见（反向回归闸：任何一条丢弃都必须有一条告警）。
    expect(report.alerts.some(alert => alert.includes('text.transform'))).toBe(true)
    const text = renderCapabilityDeclarationReport(report)
    expect(text).toContain('text.transform')
    expect(text).toContain('PLATFORM_DID_NOT_ACKNOWLEDGE')
    expect(text).toContain('差集')
  })

  it('平台承认了本机没声明的东西也要点名（多出来的同样是"对不上账"）', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items: [{ id: 'numpy', kind: 'package' }], mirror, health: port(['compute.numeric']),
      ownerPolicy: policy({ defaultTier: 'auto', autoWhitelist: ['compute.numeric'] }),
      acknowledged: ['compute.numeric', 'render.3d'],
    })
    expect(report.difference.unexpected).toEqual(['render.3d'])
    expect(report.alerts.some(alert => alert.includes('render.3d'))).toBe(true)
  })

  it('平台没回读时不许假装"平台侧没丢"：说清这次差集只覆盖本侧', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items: [{ id: 'numpy', kind: 'package' }], mirror, health: port(['compute.numeric']),
      ownerPolicy: policy({ defaultTier: 'auto', autoWhitelist: ['compute.numeric'] }),
      acknowledged: null,
    })
    expect(report.difference.platformReadback).toBe(false)
    expect(report.difference.acknowledged).toBeNull()
    expect(report.requiresOwnerAttention).toBe(true)
    expect(report.alerts.join('\n')).toContain('未回读')
    expect(report.risks.join('\n')).toContain('平台侧丢弃不可见')
  })

  it('每一条丢弃都有对应的告警（一条丢弃配一条告警，不许有静默的丢弃）', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items: [
        { id: 'ffprobe', kind: 'tool' },
        { id: 'numpy', kind: 'package' },
      ],
      mirror, health: port(['compute.numeric']),
      ownerPolicy: policy(),
      acknowledged: null,
      declaredNames: ['text.transfrom'],
      outboundFields: ['native_bins'],
    })
    // 四条丢弃，顺序是管线顺序（② 映射 → ④ 核名 → ⑥ 主人 → ⑤ 平台）：
    // 未映射项 ffprobe / 核名不过 text.transfrom / 等主人确认 compute.numeric / 字段会被静默丢弃 native_bins
    expect(report.difference.dropped.map(drop => `${drop.name}:${drop.stage}`)).toEqual([
      'ffprobe:mapping',
      'text.transfrom:preflight',
      'compute.numeric:owner',
      'native_bins:platform',
    ])
    // 告警数 == 丢弃数 + 1（未回读这条独立告警）：每条丢弃都必须有且只有一条告警。
    expect(report.alerts.length).toBe(report.difference.dropped.length + 1)
    for (const drop of report.difference.dropped) {
      expect(report.alerts.filter(alert => alert.includes(` · ${drop.name} · `)).length).toBe(1)
    }
    expect(report.requiresOwnerAttention).toBe(true)
    expect(report.unmapped.map(item => item.localId)).toEqual(['ffprobe'])
    expect(report.fieldDrops.map(field => field.key)).toEqual(['native_bins'])
  })
})

describe('② 回归闸：两次真实事故的形状必须在节点侧就被点名', () => {
  it('事故① native_bins：出站档案里出现 native_bins ⇒ 可见告警指出平台真名 native_binaries', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items: [{ id: 'numpy', kind: 'package' }], mirror, health: port(['compute.numeric']),
      ownerPolicy: policy({ defaultTier: 'auto', autoWhitelist: ['compute.numeric'] }),
      acknowledged: ['compute.numeric'],
      // 这正是 `node-capability.ts` 曾经发出的形状：native_binaries 被写成 native_bins。
      outboundFields: ['os', 'arch', 'native_bins', 'provided_capabilities'],
    })
    expect(report.fieldDrops).toEqual([
      {
        key: 'native_bins',
        reason: 'MISSPELLED_PLATFORM_FIELD',
        suggestion: 'native_binaries',
        detail: expect.stringContaining('native_binaries'),
      },
    ])
    expect(report.requiresOwnerAttention).toBe(true)
    const text = renderCapabilityDeclarationReport(report)
    expect(text).toContain('native_bins')
    expect(text).toContain('native_binaries')
  })

  it('事故① 的对偶：写对 native_binaries 就不报警（回归闸不许变成永久噪声）', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items: [{ id: 'numpy', kind: 'package' }], mirror, health: port(['compute.numeric']),
      ownerPolicy: policy({ defaultTier: 'auto', autoWhitelist: ['compute.numeric'] }),
      acknowledged: ['compute.numeric'],
      outboundFields: ['os', 'native_binaries', 'provided_capabilities'],
    })
    expect(report.fieldDrops).toEqual([])
    expect(report.requiresOwnerAttention).toBe(false)
  })

  it('事故② 旧式裸名：声明 word_count ⇒ 核名不过 ⇒ 不发出去，但必须进差集并给出正确契约名', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items: [{ id: 'word-runner', kind: 'workflow', capability: 'text.transform' }],
      mirror, health: port(['text.transform']),
      ownerPolicy: policy({ defaultTier: 'auto', autoWhitelist: ['text.transform'] }),
      acknowledged: ['text.transform'],
      declaredNames: ['word_count'],
    })

    // 1. 不发出去（"核不过 ⇒ 不发"）
    expect(report.outbound.map(ad => ad.name)).toEqual(['text.transform'])
    expect(report.outbound.map(ad => ad.name)).not.toContain('word_count')

    // 2. 必须可见：差集里有它，且原因与建议都对
    expect(report.difference.dropped).toEqual([
      {
        name: 'word_count',
        stage: 'preflight',
        reason: 'LEGACY_TASK_TYPE_NAME',
        detail: expect.stringContaining('text.transform'),
      },
    ])
    expect(report.requiresOwnerAttention).toBe(true)
    expect(report.alerts.some(alert => alert.includes('word_count') && alert.includes('text.transform'))).toBe(true)
  })

  it('拼错的契约名同样：不发出去，但点名并给最近的那个契约名', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items: [{ id: 'word-runner', kind: 'workflow', capability: 'text.transform' }],
      mirror, health: port(['text.transform']),
      ownerPolicy: policy({ defaultTier: 'auto', autoWhitelist: ['text.transform'] }),
      acknowledged: ['text.transform'],
      declaredNames: ['text.transfrom'],
    })
    const drop = report.difference.dropped.find(entry => entry.name === 'text.transfrom')
    expect(drop?.stage).toBe('preflight')
    expect(drop?.reason).toBe('UNKNOWN_CONTRACT_NAME')
    expect(drop?.detail).toContain('text.transform')
  })
})

describe('③ 假健康：文件在但起不来 ⇒ 不进候选，且原因可解释', () => {
  it('本机探测说 verified 的 ffmpeg，真实最小调用没发生 ⇒ 该项不进候选、不进声明、进差集', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items: [{ id: 'ffmpeg', kind: 'tool' }],
      mirror,
      health: port(['media.probe', 'media.thumbnail', 'audio.extract', 'audio.transcode'], {
        'media.transcode': { invoked: false, ok: true, detail: 'PATH 里有 ffmpeg，版本号可读' },
      }),
      ownerPolicy: policy({
        defaultTier: 'manual',
        confirmed: ['media.transcode', 'media.probe', 'media.thumbnail', 'audio.extract', 'audio.transcode'],
      }),
      acknowledged: ['media.probe', 'media.thumbnail', 'audio.extract', 'audio.transcode'],
    })

    expect(report.candidates).not.toContain('media.transcode')
    expect(report.outbound.map(ad => ad.name)).not.toContain('media.transcode')
    expect(report.difference.dropped).toEqual([
      {
        name: 'media.transcode',
        stage: 'health',
        reason: 'PROBE_NOT_AN_INVOCATION',
        detail: expect.stringContaining('ffmpeg'),
      },
    ])
    expect(report.alerts.some(alert => alert.includes('media.transcode'))).toBe(true)
  })

  it('健康探测通过但主人没确认 ⇒ 也进差集，原因指向"等主人确认"而不是"装不上"', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items: [{ id: 'numpy', kind: 'package' }], mirror, health: port(['compute.numeric']),
      ownerPolicy: policy(),
      acknowledged: null,
    })
    expect(report.difference.dropped).toEqual([
      {
        name: 'compute.numeric',
        stage: 'owner',
        reason: 'MANUAL_TIER_AWAITING_OWNER',
        detail: expect.any(String),
      },
    ])
  })

  it('光写一个契约名不算证据：declaredNames 里平台认、本机却没探过的能力不许声明', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items: [{ id: 'numpy', kind: 'package' }], mirror, health: port(['compute.numeric']),
      ownerPolicy: policy({ defaultTier: 'auto', autoWhitelist: ['compute.numeric', 'media.transcode'] }),
      acknowledged: ['compute.numeric'],
      declaredNames: ['media.transcode'],
    })
    expect(report.outbound.map(ad => ad.name)).toEqual(['compute.numeric'])
    expect(report.difference.dropped).toEqual([
      {
        name: 'media.transcode',
        stage: 'health',
        reason: 'NO_HEALTH_OBSERVATION',
        detail: expect.stringContaining('declaredNames'),
      },
    ])
    expect(report.requiresOwnerAttention).toBe(true)
  })
})

describe('⑤ 全自动档：白名单外不得自动开', () => {
  it('白名单只有 text.transform ⇒ compute.numeric 在自动档下也不得开出，且可见原因', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items: [
        { id: 'numpy', kind: 'package' },
        { id: 'word-runner', kind: 'workflow', capability: 'text.transform' },
      ],
      mirror,
      health: port(['compute.numeric', 'text.transform']),
      ownerPolicy: policy({ defaultTier: 'auto', autoWhitelist: ['text.transform'] }),
      acknowledged: ['text.transform'],
    })

    expect(report.outbound.map(ad => ad.name)).toEqual(['text.transform'])
    expect(report.difference.dropped).toEqual([
      {
        name: 'compute.numeric',
        stage: 'owner',
        reason: 'AUTO_WHITELIST_MISS',
        detail: expect.any(String),
      },
    ])
    expect(report.approvals.find(verdict => verdict.capability === 'text.transform')?.reason).toBe('AUTO_WHITELIST_HIT')
  })

  it('敏感能力即便在白名单里也不得自动开（涉网络永远人工确认）', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items: [
        { id: 'requests', kind: 'package' },
        { id: 'selectolax', kind: 'package' },
      ],
      mirror,
      health: port(['web.fetch']),
      ownerPolicy: policy({ defaultTier: 'auto', autoWhitelist: ['web.fetch'] }),
      acknowledged: [],
    })
    expect(report.outbound).toEqual([])
    expect(report.difference.dropped).toEqual([
      {
        name: 'web.fetch',
        stage: 'owner',
        reason: 'SENSITIVE_REQUIRES_OWNER',
        detail: expect.stringContaining('network'),
      },
    ])
    expect(report.requiresOwnerAttention).toBe(true)
  })
})

describe('① 未映射项在跨步结果里同样不许静默消失', () => {
  it('本机装了契约名对不上的工具 ⇒ 未映射清单 + 告警 + 主人可读文本三处都要有', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items: [
        { id: 'numpy', kind: 'package' },
        { id: 'ffprobe', kind: 'tool' },
      ],
      mirror, health: port(['compute.numeric']),
      ownerPolicy: policy({ defaultTier: 'auto', autoWhitelist: ['compute.numeric'] }),
      acknowledged: ['compute.numeric'],
    })
    expect(report.unmapped).toEqual([
      { localId: 'ffprobe', localKind: 'tool', reason: 'NO_REGISTRY_IMPLEMENTATION', detail: expect.any(String) },
    ])
    expect(report.alerts.some(alert => alert.includes('ffprobe'))).toBe(true)
    expect(renderCapabilityDeclarationReport(report)).toContain('ffprobe')
    expect(report.requiresOwnerAttention).toBe(true)
  })
})

describe('⑥ Scout 只产出建议，无开闸权', () => {
  const request = {
    items: [
      { id: 'numpy', kind: 'package' as const },
      { id: 'ffprobe', kind: 'tool' as const },
    ],
    mirror,
    health: port(['compute.numeric']),
    ownerPolicy: policy(),
    acknowledged: null,
  }

  it('每一条丢弃都产出一条建议，建议里只有"要主人做什么"，没有开闸动作', async () => {
    const report = await runCapabilityDeclarationPipeline(request)
    const suggestions = scoutCapabilitySuggestions(report)
    // 一条丢弃一条建议 + 未回读一条。
    expect(suggestions.length).toBe(report.difference.dropped.length + 1)
    expect(suggestions.every(suggestion => suggestion.requiresOwnerApproval)).toBe(true)
    expect(suggestions.some(suggestion => suggestion.actionable === 'map-local-item')).toBe(true)
    expect(suggestions.some(suggestion => suggestion.actionable === 'owner-confirm')).toBe(true)
    expect(suggestions.some(suggestion => suggestion.actionable === 'report-to-platform')).toBe(true)
  })

  it('建议在主人确认前不得改变出站声明（Scout 无开闸权）', async () => {
    const report = await runCapabilityDeclarationPipeline(request)
    const suggest = scoutCapabilitySuggestions(report).find(suggestion => suggestion.actionable === 'owner-confirm')!
    const refused = applyCapabilitySuggestion(report, suggest.id, { ownerConfirmed: false })
    expect(refused.applied).toBe(false)
    expect(refused.reason).toBe('OWNER_CONFIRMATION_REQUIRED')
    expect(refused.outbound).toEqual(report.outbound)
  })

  it('主人确认之后才生效，且只多出被确认的那一项', async () => {
    const report = await runCapabilityDeclarationPipeline(request)
    const suggest = scoutCapabilitySuggestions(report).find(suggestion => suggestion.actionable === 'owner-confirm')!
    const applied = applyCapabilitySuggestion(report, suggest.id, { ownerConfirmed: true })
    expect(applied.applied).toBe(true)
    expect(applied.reason).toBe('OWNER_CONFIRMED')
    expect(applied.outbound.map(ad => ad.name)).toEqual(['compute.numeric'])
  })

  it('建议不是动作：名字/健康/映射类建议即便主人点了确认也不能由 Scout 自己改', async () => {
    const report = await runCapabilityDeclarationPipeline({
      ...request,
      declaredNames: ['word_count'],
    })
    const fixName = scoutCapabilitySuggestions(report).find(suggestion => suggestion.actionable === 'fix-name')!
    const refused = applyCapabilitySuggestion(report, fixName.id, { ownerConfirmed: true })
    expect(refused.applied).toBe(false)
    expect(refused.reason).toBe('SUGGESTION_NOT_APPLICABLE')
    expect(refused.outbound.map(ad => ad.name)).not.toContain('word_count')
  })

  it('不存在的建议 id 被拒绝，不抛错（出口要稳）', async () => {
    const report = await runCapabilityDeclarationPipeline(request)
    const refused = applyCapabilitySuggestion(report, 'no-such-suggestion', { ownerConfirmed: true })
    expect(refused.applied).toBe(false)
    expect(refused.reason).toBe('UNKNOWN_SUGGESTION')
  })
})

describe('报告自述：镜像风险与未回读风险必须写在主人读得到的文本里', () => {
  it('渲染文本包含六步各自的产物（清单/映射/健康/核名/差集/风险）', async () => {
    const report = await runCapabilityDeclarationPipeline({
      items: [
        { id: 'ffmpeg', kind: 'tool' },
        { id: 'ffprobe', kind: 'tool' },
      ],
      mirror, health: port(['media.transcode', 'media.probe', 'media.thumbnail', 'audio.extract', 'audio.transcode']),
      ownerPolicy: policy({ defaultTier: 'auto', autoWhitelist: ['media.probe'] }),
      acknowledged: ['media.probe'],
    })
    const text = renderCapabilityDeclarationReport(report)
    for (const heading of ['本机清单', '契约名映射', '健康探测', '声明前核名', '差集', '风险']) {
      expect(text).toContain(heading)
    }
    expect(text).toContain('镜像')
  })
})
