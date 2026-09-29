/**
 * C19 · 档 1 · 改动三：把 **A2 意外护栏**登记成一条钉子（谁删它谁红）。
 *
 * ## 护栏是什么
 *
 * `isolated-agent.ts` 会把平台文本交给一个新建的专员会话。那个会话在 setup 里把工具列表收成空，
 * 并拒绝每一次工具调用。白名单仍然不许非 `text.transform` 的类型变成 available。
 *
 * 非 `text.transform` 的类型仍然不可准入，**靠的是** `owner-policy.ts` 里那行能力白名单
 * （`capabilityId === 'text.transform'`）：agent 类型不是它 ⇒ `NO_AUTHORIZED_SERVICE` ⇒ policy `OFF`。
 * 已准入的 `word_count` 在配了隔离路由时进入专员会话；那个会话把工具列表收成空。
 *
 * ## 为什么必须钉住
 *
 * 那份白名单的**注释动机**是"模型账户授权 / 没有可验证的 service-to-runner 绑定"，**不是**"防注入"
 * —— 也就是说它挡住注入面是**意外的**（C16 §A2 原文："这条兜底是意外的……所以它是一份应当被显式登记的
 * 护栏，而不是可以被默默依赖的巧合"，`report-C16-N1准入证据与收紧方案.md:525-533`）。
 * 一个没人注册的护栏，会在某次"顺手放宽白名单"的改动里静默消失，而那一刻注入面就变成可达的。
 *
 * ## 这一条钉住什么
 *
 * 下面两个用例互为对照，只差"类型是不是 agent 路由"：
 * - agent 类型 ⇒ 被 `NO_AUTHORIZED_SERVICE` 挡住、policy `OFF`、能力 `available=false`；
 * - 交付类型（`word_count` → `text.transform`）⇒ 全部放行。
 *
 * 谁放宽白名单（或删掉那一行），第一个用例红；谁把交付的 `text.transform` 从白名单里拿掉，
 * 第二个用例红。先红实测：把白名单的 `capability.capabilityId === 'text.transform' &&` 条件删掉后，
 * 第一个用例确实变红（见 `report-C19-N1档1痕迹与钉子.md` §3）。
 */
import { describe, expect, it } from 'vitest'
import {
  capabilityIdIfRegistered,
  hasIsolatedInlineRunner,
  type ContributorPolicy,
  type SupplyPolicy,
} from '@deepseek-ai/dsh-compute-core'
import type { ResidentCapability } from '@deepseek-ai/dsh-compute-core/resident'
import { projectOwnerAdmission, type OwnerAdmissionFacts } from '../src/owner-policy.ts'

/** 交付默认档：`BACKGROUND_ONLY`，且 `allowWhileUserActive` 被强制为 false。 */
const DEPLOYMENT: ContributorPolicy = {
  mode: 'BACKGROUND_ONLY',
  maxConcurrency: 1,
  maxCpuPercent: 50,
  maxGpuPercent: 0,
  maxTemperatureC: 80,
  minDiskFreeBytes: 10_737_418_240,
  allowWhileUserActive: false,
}

/** 主人已经显式开闸（供给策略 `allowed` + `enabledServiceIds` 含 `node`）：这是最宽的好情况。 */
const OWNER: SupplyPolicy = {
  mode: 'allowed',
  maxConcurrency: 1,
  minFreeMemoryBytes: 0,
  minIdleSeconds: 0,
  enabledServiceIds: ['node'],
  nodeRates: [],
}

/** 每个"本机事实"都可测且不拦：护栏要是今天唯一在起作用的东西。 */
const FACTS: OwnerAdmissionFacts = {
  activity: { userActive: false, idleSeconds: 9_999, unavailable: null },
  voiceActive: false,
  foregroundTaskActive: false,
  freeMemoryBytes: 8_000_000_000,
  runningTasks: 0,
}

/** 一条 agent 路由今天会广告出来的能力：`capabilityId` 就是未登记的落地名原样。 */
const AGENT_ROUTE_CAPABILITY: ResidentCapability = {
  capabilityId: 'ocr_image',
  version: '1.0.0',
  pluginDigest: 'a'.repeat(64),
  dataScope: 'none',
  maxInputBytes: 0,
  maxOutputBytes: 1_048_576,
  available: true,
}

/** 交付类型的同一条能力：`word_count` 在注册表里就是 `text.transform`（`capability-registry.ts:131`）。 */
const TEXT_CAPABILITY: ResidentCapability = {
  ...AGENT_ROUTE_CAPABILITY,
  capabilityId: 'text.transform',
  pluginDigest: 'b'.repeat(64),
}

describe('C19 · A2 意外护栏：能力白名单挡住了 agent 路由的注入面', () => {
  it('the whitelist keeps the agent route unauthorized, which is what keeps isolated-agent.ts unreachable', () => {
    // 前提：`ocr_image` 真的是一条 **agent 路由**（没有 in-process runner），且它不是 `text.transform`。
    expect(capabilityIdIfRegistered('ocr_image')).not.toBe('text.transform')
    expect(hasIsolatedInlineRunner('ocr_image')).toBe(false)

    const admission = projectOwnerAdmission(DEPLOYMENT, OWNER, FACTS, [AGENT_ROUTE_CAPABILITY], ['ocr_image'])

    // 护栏生效的**唯一**表现：白名单把它判成"没有已授权的服务"。这不是一道注入检查——
    // 链路里没有那种检查；挡住它的正是那条以"模型账户授权"为动机的白名单。
    expect(admission.reasons).toEqual(['NO_AUTHORIZED_SERVICE'])
    expect(admission.policy.mode).toBe('OFF')
    expect(admission.capabilities).toEqual([{ ...AGENT_ROUTE_CAPABILITY, available: false }])
  })

  it('the same everything, but with the shipped landing type, is admitted', () => {
    const admission = projectOwnerAdmission(DEPLOYMENT, OWNER, FACTS, [TEXT_CAPABILITY], ['word_count'])

    expect(admission.reasons).toEqual([])
    expect(admission.policy.mode).toBe('BACKGROUND_ONLY')
    expect(admission.capabilities).toEqual([{ ...TEXT_CAPABILITY, available: true }])
  })

  it('an agent route mixed into a shipped list is denied for itself only, and the node stays admitted', () => {
    // 实测更正（C19）：护栏**按能力逐项**生效，不是"整台机器被关掉"。
    // 混合列表里 `authorized` 非空（`text.transform` 那条在），所以节点照旧被受理；
    // agent 那条能力则始终 `available=false` ⇒ 平台侧没有任何可路由到它的读数。
    const admission = projectOwnerAdmission(
      DEPLOYMENT, OWNER, FACTS,
      [TEXT_CAPABILITY, AGENT_ROUTE_CAPABILITY],
      ['word_count', 'ocr_image'],
    )

    expect(admission.reasons).toEqual([])
    expect(admission.policy.mode).toBe('BACKGROUND_ONLY')
    expect(admission.capabilities).toEqual([
      { ...TEXT_CAPABILITY, available: true },
      { ...AGENT_ROUTE_CAPABILITY, available: false },
    ])
    // 而"只有 agent 路由"的列表会让整台机器归零（上一个用例）：两条合起来说明
    // 护栏的边界是**能力**，不是节点。
    const onlyAgent = projectOwnerAdmission(DEPLOYMENT, OWNER, FACTS, [AGENT_ROUTE_CAPABILITY], ['ocr_image'])
    expect(onlyAgent.reasons).toEqual(['NO_AUTHORIZED_SERVICE'])
    expect(onlyAgent.policy.mode).toBe('OFF')
  })

  it('no task list can authorize a capability other than text.transform', () => {
    // 护栏的**性质形式**：不管 `allowedTaskTypes` 怎么配，`available=true` 的能力只可能是
    // `text.transform`。这条覆盖"agent 类型混进任何列表"的全部情形，因此放宽白名单（哪怕只放宽成
    // 「按能力逐项批准」）必然让它红——这就是"谁删它谁红"这一条钉子的着力点。
    const lists: readonly string[][] = [[], ['word_count'], ['ocr_image'], ['word_count', 'ocr_image'],
      ['base64_decode', 'ocr_image'], ['text_sort']]
    for (const list of lists) {
      const admission = projectOwnerAdmission(DEPLOYMENT, OWNER, FACTS, [TEXT_CAPABILITY, AGENT_ROUTE_CAPABILITY], list)
      const authorized = admission.capabilities.filter(capability => capability.available)
      expect(authorized.map(capability => capability.capabilityId),
        `list ${JSON.stringify(list)} must not authorize an agent capability`).toEqual(
        authorized.length === 0 ? [] : ['text.transform'],
      )
    }
  })

  it('the guard is incidental, not injection-specific: any reason that empties the whitelist blocks it identically', () => {
    // 这条钉住"意外"这个性质本身：把主人的 `enabledServiceIds` 去掉（与注入面毫无关系的授权事实）
    // 会让 agent 路由得到**完全相同**的读数。也就是说，今天挡住注入面的不是任何注入防护，
    // 而是"授权白名单恰好不含 agent 类型"这一件事。
    const withoutService = projectOwnerAdmission(DEPLOYMENT, { ...OWNER, enabledServiceIds: [] }, FACTS, [AGENT_ROUTE_CAPABILITY], ['ocr_image'])
    const withService = projectOwnerAdmission(DEPLOYMENT, OWNER, FACTS, [AGENT_ROUTE_CAPABILITY], ['ocr_image'])

    expect(withoutService.reasons).toEqual(withService.reasons)
    expect(withoutService.policy.mode).toBe(withService.policy.mode)
    expect(withoutService.capabilities).toEqual(withService.capabilities)
  })
})
