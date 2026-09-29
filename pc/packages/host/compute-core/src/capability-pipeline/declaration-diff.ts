/**
 * 工单 8 · 第 ⑤ 步（本工单最重要）：**丢弃可见化** —— 出站声明与平台实际承认的能力做差集。
 *
 * ## 这个模块防的是什么
 *
 * 平台对上报字段做静默白名单过滤（`storage/repo.py:1811-1814`），准入闸只放行它认得的契约名
 * （`services/capability_shadow.py:252`）。两侧都没有回执，于是"我报了 3 项、平台只认 2 项"
 * 这件事在节点侧**完全没有出口** —— 主人的体感是"我明明装了、也开了，却一直没单"，而且查不出原因。
 *
 * 所以差集不是"顺便统计一下"，它是本工单的**交付物本体**：
 * - 每一项没走到终点的能力，都必须带**在哪一步丢的**（`stage`）与**为什么**（`reason`/`detail`）；
 * - 差集非空 ⇒ 主人一定能看见（`pipeline.ts` 为每条丢弃生成一条告警，这是一条反向回归闸）。
 *
 * ## 一个必须说清的诚实性约束
 *
 * 平台**没有回读**时（拿不到 worker 行），不许把"平台侧没丢"当成结论：
 * `platformReadback: false` 明示这次差集只覆盖**本侧**的丢弃，平台侧的丢弃不可见。
 */

/** 一条能力是在管线的哪一步停下的。 */
export type DeclarationStage =
  /** 第 ② 步：本机项落不到契约名上（含角色组不齐）。 */
  | 'mapping'
  /** 第 ③ 步：最小真实调用没通过 / 本机没有该项的探测证据。 */
  | 'health'
  /** 第 ④ 步：平台注册表核名不过（旧式裸名、拼错的名字、字段名当能力名）。 */
  | 'preflight'
  /** 第 ⑥ 步：主人的三档策略不放行（等确认 / 白名单外 / 敏感动作）。 */
  | 'owner'
  /** 第 ⑤ 步：发出去了，但平台没承认（被准入闸剔除或落在字段白名单外）。 */
  | 'platform'

/** 一条没有走到终点的能力：名字、停在哪一步、原因码、主人可读的细节。 */
export interface DeclarationDrop {
  readonly name: string
  readonly stage: DeclarationStage
  readonly reason: string
  readonly detail: string
}

/** 差集：本机声明 vs 平台承认，加上本侧各步骤已经丢掉的项。 */
export interface DeclarationDifference {
  /** 真正发出去的声明（第 ④⑥ 步都通过的）。 */
  readonly declared: readonly string[]
  /** 平台回读到的能力；`null` 表示没有回读（降级模式），不是"空"。 */
  readonly acknowledged: readonly string[] | null
  /** 所有没走到终点的项（含本侧各步骤的丢弃与平台侧的未承认）。 */
  readonly dropped: readonly DeclarationDrop[]
  /** 平台承认了、但本机没声明的能力（出现即"对不上账"，必须点名）。 */
  readonly unexpected: readonly string[]
  /** 是否拿到了平台回读。`false` ⇒ 平台侧的丢弃**不可见**，不许当成"没丢"。 */
  readonly platformReadback: boolean
  /** 差集为空（既没有丢弃，也没有多出来的）。 */
  readonly empty: boolean
}

/** 步骤在报告里的先后顺序（差集按它排序，主人从上往下读就是管线的顺序）。 */
const STAGE_ORDER: Readonly<Record<DeclarationStage, number>> = Object.freeze({
  mapping: 0,
  health: 1,
  preflight: 2,
  owner: 3,
  platform: 4,
})

/**
 * 算差集。
 * @param input - 出站声明、平台回读结果、以及本侧各步骤已经记下的丢弃。
 * @returns 差集；平台侧未承认的项会以 `stage: 'platform'` 补进 `dropped`。
 */
export function diffCapabilityDeclaration(input: {
  readonly declared: readonly string[]
  readonly acknowledged: readonly string[] | null
  readonly priorDrops?: readonly DeclarationDrop[]
}): DeclarationDifference {
  const declared = [...new Set(input.declared)].sort()
  const acknowledged = input.acknowledged === null ? null : [...new Set(input.acknowledged)].sort()
  const dropped: DeclarationDrop[] = [...(input.priorDrops ?? [])]

  if (acknowledged !== null) {
    for (const name of declared) {
      if (acknowledged.includes(name)) continue
      dropped.push({
        name, stage: 'platform', reason: 'PLATFORM_DID_NOT_ACKNOWLEDGE',
        detail: `本机声明了 ${name}，但平台回读的 worker 行里没有它：可能被 hello_union_gate（services/capability_shadow.py:252）剔除，`
          + '或落在字段白名单之外（storage/repo.py:1811-1814）。平台的丢弃没有回执 ⇒ 只能靠这次核账发现。',
      })
    }
  }

  const unexpected = acknowledged === null ? [] : acknowledged.filter(name => !declared.includes(name))
  const sortedDrops = [...dropped].sort((left, right) =>
    STAGE_ORDER[left.stage] - STAGE_ORDER[right.stage] || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

  return {
    declared,
    acknowledged,
    dropped: sortedDrops,
    unexpected,
    platformReadback: acknowledged !== null,
    empty: sortedDrops.length === 0 && unexpected.length === 0,
  }
}
