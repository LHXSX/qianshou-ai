/**
 * 工单 8 · 第 ⑥ 步：主人三档确认（手动默认 / 半自动逐条确认 / 全自动仅白名单内）。
 *
 * ## 这个测试防的是什么
 *
 * 设计稿 §1.3 说全自动"只允许在同时满足下列条件时自行变更"，并已实测记录一条**反面教训**：
 * `productionGaps` 在默认 profile 下**数学上恒空**，而它按设计是"空才允许开闸"的判据 ——
 * 全自动档如果照抄这个结构，就等于把闸门交给一个永远说"都可以"的判据。
 *
 * 所以本模块把三档写成**按能力逐项**的判定，并把三条硬边界做成判据本身：
 * 1. 白名单默认空 ⇒ 全自动什么都不能开；
 * 2. 涉文件/网络/进程 ⇒ **永远**要求人工确认，进白名单也不行；
 * 3. 三档是**每能力一项**，不是全局开关。
 */
import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_ACTION_CLASSES,
  SENSITIVE_ACTION_CLASSES,
  decideCapabilityApproval,
  defaultOwnerCapabilityPolicy,
  type OwnerCapabilityApprovalPolicy,
} from '../../src/capability-pipeline/owner-approval.ts'

function policy(overrides: Partial<OwnerCapabilityApprovalPolicy> = {}): OwnerCapabilityApprovalPolicy {
  return { ...defaultOwnerCapabilityPolicy(), ...overrides }
}

describe('默认档就是手动：没有主人动手，任何能力都不广告', () => {
  it('默认策略是全手动、空白名单、空确认记录', () => {
    expect(defaultOwnerCapabilityPolicy()).toEqual({
      defaultTier: 'manual',
      perCapability: {},
      autoWhitelist: [],
      confirmed: [],
    })
  })

  it('手动档下未确认的能力 ⇒ 等主人确认，且原因说清"这是默认档"', () => {
    const verdict = decideCapabilityApproval('text.transform', policy())
    expect(verdict.decision).toBe('needs-owner-confirmation')
    expect(verdict.tier).toBe('manual')
    expect(verdict.reason).toBe('MANUAL_TIER_AWAITING_OWNER')
  })

  it('手动档下主人已经逐条确认过的能力 ⇒ 通过', () => {
    const verdict = decideCapabilityApproval('text.transform', policy({ confirmed: ['text.transform'] }))
    expect(verdict.decision).toBe('approved')
    expect(verdict.reason).toBe('OWNER_CONFIRMED')
  })
})

describe('⑤ 全自动档：白名单外不得自动开', () => {
  it('白名单为空时，全自动档开不出任何东西（默认空 = 全自动什么都不能开）', () => {
    const verdict = decideCapabilityApproval('compute.numeric', policy({ defaultTier: 'auto' }))
    expect(verdict.decision).toBe('refused')
    expect(verdict.reason).toBe('AUTO_WHITELIST_MISS')
  })

  it('白名单内的能力才自动通过，并且原因是"白名单命中"而不是"默认放行"', () => {
    const approved = decideCapabilityApproval('compute.numeric', policy({ defaultTier: 'auto', autoWhitelist: ['compute.numeric'] }))
    expect(approved.decision).toBe('approved')
    expect(approved.reason).toBe('AUTO_WHITELIST_HIT')

    const refused = decideCapabilityApproval('compute.numeric', policy({ defaultTier: 'auto', autoWhitelist: ['text.transform'] }))
    expect(refused.decision).toBe('refused')
    expect(refused.reason).toBe('AUTO_WHITELIST_MISS')
  })

  it('涉网络的 web.fetch 即便进了白名单也永远要求人工确认（全自动不得越界）', () => {
    const verdict = decideCapabilityApproval('web.fetch', policy({ defaultTier: 'auto', autoWhitelist: ['web.fetch'] }))
    expect(verdict.decision).toBe('needs-owner-confirmation')
    expect(verdict.reason).toBe('SENSITIVE_REQUIRES_OWNER')
    expect(verdict.sensitiveActions).toEqual(['network'])
  })

  it('涉文件与涉进程的能力同样永远要求人工确认，且三类动作都要列出来', () => {
    expect(decideCapabilityApproval('media.transcode', policy({ defaultTier: 'auto', autoWhitelist: ['media.transcode'] })).sensitiveActions)
      .toEqual(['file', 'process'])
    expect(decideCapabilityApproval('doc.pdf.extract', policy({ defaultTier: 'auto', autoWhitelist: ['doc.pdf.extract'] })).decision)
      .toBe('needs-owner-confirmation')
    expect(decideCapabilityApproval('llm.generate.local', policy({ defaultTier: 'auto', autoWhitelist: ['llm.generate.local'] })).decision)
      .toBe('needs-owner-confirmation')
  })

  it('敏感能力主人逐条确认之后仍然能开（人工确认是闸门，不是禁令）', () => {
    const verdict = decideCapabilityApproval('web.fetch', policy({ defaultTier: 'auto', autoWhitelist: ['web.fetch'], confirmed: ['web.fetch'] }))
    expect(verdict.decision).toBe('approved')
    expect(verdict.reason).toBe('OWNER_CONFIRMED')
  })

  it('三档是"每能力一项"：同一次判定里数词可全自动、转码必须人工确认', () => {
    const mixed = policy({ defaultTier: 'manual', perCapability: { 'compute.numeric': 'auto' }, autoWhitelist: ['compute.numeric'] })
    expect(decideCapabilityApproval('compute.numeric', mixed).decision).toBe('approved')
    expect(decideCapabilityApproval('media.transcode', mixed).decision).toBe('needs-owner-confirmation')
    expect(decideCapabilityApproval('media.transcode', mixed).tier).toBe('manual')
  })
})

describe('半自动档：系统推荐、主人逐条确认', () => {
  it('未确认 ⇒ 等主人确认，原因与手动档区分开', () => {
    const verdict = decideCapabilityApproval('compute.numeric', policy({ defaultTier: 'semi-auto' }))
    expect(verdict.decision).toBe('needs-owner-confirmation')
    expect(verdict.reason).toBe('SEMI_AUTO_AWAITING_OWNER')
  })

  it('逐条确认过的那一项通过，其余仍等确认（半自动不等于批量放行）', () => {
    const semi = policy({ defaultTier: 'semi-auto', confirmed: ['compute.numeric'] })
    expect(decideCapabilityApproval('compute.numeric', semi).decision).toBe('approved')
    expect(decideCapabilityApproval('text.transform', semi).decision).toBe('needs-owner-confirmation')
  })
})

describe('动作分类表必须只覆盖注册表里的契约名，且默认空', () => {
  it('降级未知能力不猜动作类别：不在表里就是"非敏感"，不用编造的类别拦人', () => {
    expect(decideCapabilityApproval('some.future.capability', policy({ defaultTier: 'auto', autoWhitelist: ['some.future.capability'] })).sensitiveActions)
      .toEqual([])
  })

  it('敏感类别就是文件/网络/进程这三类（涉它们永远人工确认）', () => {
    expect([...SENSITIVE_ACTION_CLASSES].sort()).toEqual(['file', 'network', 'process'])
    expect(CAPABILITY_ACTION_CLASSES['web.extract']).toEqual(['network'])
    expect(CAPABILITY_ACTION_CLASSES['text.transform']).toEqual([])
  })
})
