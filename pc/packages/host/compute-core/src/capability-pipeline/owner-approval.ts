/**
 * 工单 8 · 第 ⑥ 步：主人三档确认（手动默认 / 半自动逐条确认 / 全自动仅白名单内）。
 *
 * ## 设计稿 §1.3 的三条硬边界，在这里是判据本身而不是注释
 *
 * 1. **白名单默认空 ⇒ 全自动什么都不能开**。设计稿记着一条实测的反面教训：
 *    `productionGaps` 在默认 profile 下**数学上恒空**，而它按设计是"空才允许开闸"的判据 ——
 *    全自动档若照抄这种结构，等于把闸门交给一个永远说"都可以"的判据。所以这里不检查
 *    "gaps 是否为空"，而是检查**白名单是否真的点了这一项**。
 * 2. **涉文件/网络/进程永远要求人工确认**：进了白名单也不行。
 * 3. **三档是"每能力一项"**，不是全局开关：数词可以全自动接，视频转码必须逐条确认。
 *
 * ## 探测只给建议，开闸永远是人（或人的规则）
 *
 * 本模块不探任何东西：它只回答"主人对这项能力配的档位，允许这一次开闸吗"。
 * Scout（第 ③ 步的探测）的产物只有"建议"，`pipeline.ts` 的
 * {@link applyCapabilitySuggestion} 才是唯一能把建议变成声明的入口，而它要求主人确认。
 */

/** 主人为一项能力配的档位。 */
export type CapabilityApprovalTier = 'manual' | 'semi-auto' | 'auto'

/** 一项能力会碰到的动作类别。 */
export type CapabilityActionClass = 'compute' | 'file' | 'network' | 'process'

/** 涉这三类动作的能力**永远**要求人工确认（设计稿 §1.3 第 3 条）。 */
export const SENSITIVE_ACTION_CLASSES: readonly CapabilityActionClass[] = Object.freeze(['file', 'network', 'process'])

/**
 * 契约能力 → 它会碰到的动作类别。
 *
 * 表的粒度到能力名为止，判据本身由 {@link decideCapabilityApproval} 用
 * {@link SENSITIVE_ACTION_CLASSES} 施加。列全 26 个注册表能力（而不是只列敏感的），
 * 是为了让"某项是空的"成为一个**显式声明**，而不是"忘了写"。
 * 表里没有的能力视为没有已知敏感动作 —— 不编造类别去拦人。
 */
export const CAPABILITY_ACTION_CLASSES: Readonly<Record<string, readonly CapabilityActionClass[]>> = Object.freeze({
  'accelerator.gpu': [],
  'audio.extract': ['file'],
  'audio.transcode': ['file'],
  'compute.numeric': [],
  'doc.pdf.extract': ['file'],
  'doc.pdf.probe': ['file'],
  'doc.spreadsheet.write': ['file'],
  'image.convert': ['file'],
  'image.generate': ['file', 'network'],
  'image.probe': ['file'],
  'image.thumbnail': ['file'],
  'image.transform': ['file'],
  'llm.generate.local': ['process'],
  'media.compose': ['file'],
  'media.probe': ['file'],
  'media.thumbnail': ['file'],
  'media.transcode': ['file', 'process'],
  'ml.onnx.infer': ['process'],
  'ocr.image': ['file'],
  'render.3d': ['file', 'process'],
  'speech.transcribe': ['file', 'process'],
  'text.transform': [],
  'video.render': ['file'],
  'vision.caption': ['file'],
  'web.extract': ['network'],
  'web.fetch': ['network'],
})

/** 主人的能力声明策略。`confirmed` 是"主人逐条点过头"的那一份名单。 */
export interface OwnerCapabilityApprovalPolicy {
  /** 默认档：没被单列的能力用这一档。默认就是 `manual`。 */
  readonly defaultTier: CapabilityApprovalTier
  /** 按能力逐项配的档位。 */
  readonly perCapability: Readonly<Record<string, CapabilityApprovalTier>>
  /** 全自动白名单；**默认空 = 全自动什么都不能开**。 */
  readonly autoWhitelist: readonly string[]
  /** 已经由主人逐条确认过的能力（半自动与敏感能力的生效前提）。 */
  readonly confirmed: readonly string[]
}

/** 一次开闸判定的结论。 */
export type CapabilityApprovalDecision = 'approved' | 'needs-owner-confirmation' | 'refused'

/** 一次开闸判定：结论 + 依据档位 + 原因码 + 该能力涉及的动作类别。 */
export interface CapabilityApprovalVerdict {
  readonly capability: string
  readonly decision: CapabilityApprovalDecision
  readonly tier: CapabilityApprovalTier
  readonly reason: string
  readonly sensitiveActions: readonly CapabilityActionClass[]
  readonly detail: string
}

/**
 * 默认策略：全手动、空白名单、空确认记录。
 *
 * 默认档是 `manual` 而不是 `semi-auto`：新装的机器环境不确定能不能跑，
 * 而 `auto` 更不是默认 —— 设计稿把默认开闸动作留给主人自己。
 * @returns 一份全新的（可变对象语义上仍然冻结使用）默认策略。
 */
export function defaultOwnerCapabilityPolicy(): OwnerCapabilityApprovalPolicy {
  return { defaultTier: 'manual', perCapability: {}, autoWhitelist: [], confirmed: [] }
}

/**
 * 判定一项能力这一次能不能开闸。
 *
 * 判定顺序是有意的：**敏感动作优先于档位**（白名单也救不了涉文件/网络/进程的能力），
 * 而 `confirmed` 是唯一能让敏感能力生效的东西 —— 人工确认是闸门，不是禁令。
 * @param capability - 契约能力名。
 * @param policy - 主人的逐项策略。
 * @returns 结论、档位、原因与被触发的敏感类别。
 */
export function decideCapabilityApproval(capability: string, policy: OwnerCapabilityApprovalPolicy): CapabilityApprovalVerdict {
  const tier = policy.perCapability[capability] ?? policy.defaultTier
  const actions = CAPABILITY_ACTION_CLASSES[capability] ?? []
  const sensitive = actions.filter(action => SENSITIVE_ACTION_CLASSES.includes(action))
  const confirmed = policy.confirmed.includes(capability)
  const base = { capability, tier, sensitiveActions: sensitive }

  if (sensitive.length > 0) {
    return confirmed
      ? { ...base, decision: 'approved', reason: 'OWNER_CONFIRMED', detail: `主人已逐条确认过 ${capability}；它涉及 ${sensitive.join('/')}，确认是它唯一的生效路径。` }
      : {
          ...base, decision: 'needs-owner-confirmation', reason: 'SENSITIVE_REQUIRES_OWNER',
          detail: `${capability} 涉及 ${sensitive.join('/')}，按设计稿 §1.3 第 3 条**永远**要求人工确认：进了白名单也不自动开。`,
        }
  }
  if (tier === 'manual') {
    return confirmed
      ? { ...base, decision: 'approved', reason: 'OWNER_CONFIRMED', detail: `主人已逐条确认过 ${capability}。` }
      : { ...base, decision: 'needs-owner-confirmation', reason: 'MANUAL_TIER_AWAITING_OWNER', detail: `${capability} 走的是默认的手动档：没有主人逐条确认就不广告。` }
  }
  if (tier === 'semi-auto') {
    return confirmed
      ? { ...base, decision: 'approved', reason: 'OWNER_CONFIRMED', detail: `主人已逐条确认过 ${capability}（半自动档的生效前提）。` }
      : { ...base, decision: 'needs-owner-confirmation', reason: 'SEMI_AUTO_AWAITING_OWNER', detail: `${capability} 走半自动档：系统只给推荐，主人逐条确认后才生效。` }
  }
  if (!policy.autoWhitelist.includes(capability)) {
    return {
      ...base, decision: 'refused', reason: 'AUTO_WHITELIST_MISS',
      detail: `全自动档只自动采纳**主人预设白名单内**的变更；${capability} 不在白名单里（白名单默认空 ⇒ 全自动默认什么都开不了）⇒ 拒绝自动开闸。`,
    }
  }
  return { ...base, decision: 'approved', reason: 'AUTO_WHITELIST_HIT', detail: `${capability} 命中主人预设的全自动白名单，且不涉及文件/网络/进程 ⇒ 允许自动开闸。` }
}
