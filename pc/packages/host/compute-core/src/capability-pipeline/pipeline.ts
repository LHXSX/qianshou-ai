/**
 * 工单 8 · 六步管线的接线本体。
 *
 * ```
 * ① 本机清单（真实扫描）
 *       ↓
 * ② 契约名映射（别名归一 + 未映射项清单 + 角色组缺口）   ── contract-map.ts
 *       ↓
 * ③ 健康探测（每项一次最小真实调用 ⇒ health）            ── health-probe.ts
 *       ↓
 * ④ 声明前核名（平台注册表镜像：字段白名单 + 契约名闸）  ── registry-mirror.ts
 *       ↓
 * ⑤ 声明 + 差集（平台实际承认了什么 vs 本机声明了什么）  ── declaration-diff.ts
 *       ↓
 * ⑥ 主人三档确认（按能力逐项配）                        ── owner-approval.ts
 * ```
 *
 * ## 三条贯穿全局的规矩
 *
 * 1. **核不过就不发**：第 ④ 步没过的名字绝不出现在 `outbound` 里，但一定出现在差集与告警里。
 * 2. **没证据就不声明**：只有第 ③ 步真的调用过一次且判为 `ok` 的能力才进候选池；
 *    光在 `declaredNames` 里写一个平台认得的契约名**不算证据**（否则"自己开闸"就回来了）。
 * 3. **差集非空 ⇒ 主人一定能看见**：每一条丢弃都由 {@link CapabilityDeclarationReport.alerts}
 *    生成一条与之对应的告警 —— 这是一条反向回归闸：任何新增的丢弃路径如果忘了生成告警，
 *    `tests/capability-pipeline/declaration-pipeline.spec.ts` 会红。
 *
 * ## Scout 的边界（对上工单 4 的四角色）
 *
 * {@link scoutCapabilitySuggestions} 只把丢弃翻译成"要主人做什么"的建议，
 * {@link applyCapabilitySuggestion} 是唯一能把建议变成声明的入口，而它**要求主人确认**；
 * 而且它只对 `owner-confirm` 类建议可执行 —— 名字/健康/映射类建议是待办，Scout 不能自己改。
 */
import { CAPABILITY_REGISTRY_VERSION } from '../capability-registry.ts'
import { type ProvidedCapabilityAd } from '../node-capability.ts'
import {
  mapLocalItemsToContract,
  normalizeAdvertisedName,
  type CapabilityMapping,
  type IncompleteImplementationGroup,
  type LocalCapabilityItem,
  type UnmappedLocalItem,
} from './contract-map.ts'
import {
  checkDeclarationNames,
  checkOutboundFields,
  type DeclarationNameVerdict,
  type OutboundFieldDrop,
  type PlatformRegistryMirror,
} from './registry-mirror.ts'
import {
  candidateCapabilities,
  healthRefusals,
  probeCapabilityHealth,
  type CapabilityHealthObservation,
  type CapabilityProbePort,
} from './health-probe.ts'
import { decideCapabilityApproval, type CapabilityApprovalVerdict, type OwnerCapabilityApprovalPolicy } from './owner-approval.ts'
import { diffCapabilityDeclaration, type DeclarationDifference, type DeclarationDrop, type DeclarationStage } from './declaration-diff.ts'

/** 管线的输入：本机清单 + 注入的探测端口 + 平台镜像 + 主人策略 + 平台回读。 */
export interface CapabilityDeclarationRequest {
  /** ① 本机真实清单（工具/包/插件/模型/工作流）。 */
  readonly items: readonly LocalCapabilityItem[]
  /** 平台注册表镜像（第 ④ 步核名与字段白名单核验的依据）。 */
  readonly mirror: PlatformRegistryMirror
  /** ③ 最小真实调用的端口。 */
  readonly health: CapabilityProbePort
  /** ⑥ 主人逐项策略。 */
  readonly ownerPolicy: OwnerCapabilityApprovalPolicy
  /** ⑤ 平台回读到的能力（worker 行）；`null` = 拿不到回读（降级模式，必须自述）。 */
  readonly acknowledged: readonly string[] | null
  /** 额外想声明的名字（例如写死在别处的常量）：只做核名，**不构成健康证据**。 */
  readonly declaredNames?: readonly string[]
  /** 出站档案会带的字段键（用于发现平台白名单会静默丢弃的字段）。 */
  readonly outboundFields?: readonly string[]
  /** 可选取消信号。 */
  readonly signal?: AbortSignal
}

/** 六步管线的完整体产物：每一步的输入输出都留在这里，主人可以逐段追问。 */
export interface CapabilityDeclarationReport {
  readonly inventory: readonly LocalCapabilityItem[]
  readonly mapped: readonly CapabilityMapping[]
  readonly unmapped: readonly UnmappedLocalItem[]
  readonly incompleteGroups: readonly IncompleteImplementationGroup[]
  readonly health: readonly CapabilityHealthObservation[]
  readonly candidates: readonly string[]
  readonly preflight: readonly DeclarationNameVerdict[]
  readonly approvals: readonly CapabilityApprovalVerdict[]
  readonly outbound: readonly ProvidedCapabilityAd[]
  readonly fieldDrops: readonly OutboundFieldDrop[]
  readonly acknowledged: readonly string[] | null
  readonly difference: DeclarationDifference
  readonly alerts: readonly string[]
  /** 有必须让主人看见的东西（差集/未映射项/字段丢弃/未回读）。false 才是"这次无事发生"。 */
  readonly requiresOwnerAttention: boolean
  readonly risks: readonly string[]
}

/** 一步丢弃在告警里的开头标签（主人一眼看出是在哪一步丢的）。 */
const STAGE_LABEL: Readonly<Record<DeclarationStage, string>> = Object.freeze({
  mapping: '未映射项（本机装了但落不到契约名）',
  health: '健康未通过（装了 ≠ 能用）',
  preflight: '声明前核名不通过（平台不认这个名字）',
  owner: '未获主人授权（三档策略不放行）',
  platform: '平台未承认（被准入闸或字段白名单丢掉）',
})

/** 没有平台回读时的风险条目：不许把"平台侧没丢"当成结论。 */
const NO_READBACK_RISK = '没有平台回读 ⇒ 平台侧丢弃不可见：这次差集只覆盖本侧丢弃，"平台没丢"不能被当成结论。'

/** 主人在建议列表里可以做什么。`owner-confirm` 是唯一可执行的；其余都是待办。 */
export type CapabilitySuggestionAction = 'map-local-item' | 'fix-name' | 'fix-health' | 'owner-confirm' | 'report-to-platform'

/** 丢弃 → 建议（Scout 的产物）的映射。 */
const ACTION_BY_STAGE: Readonly<Record<DeclarationStage, CapabilitySuggestionAction>> = Object.freeze({
  mapping: 'map-local-item',
  health: 'fix-health',
  preflight: 'fix-name',
  owner: 'owner-confirm',
  platform: 'report-to-platform',
})

/** Scout 产出的一条建议。`requiresOwnerApproval` 恒为 true：Scout 没有开闸权。 */
export interface CapabilitySuggestion {
  readonly id: string
  /** 涉及的能力名或本机项名。 */
  readonly capability: string
  readonly actionable: CapabilitySuggestionAction
  readonly why: string
  readonly requiresOwnerApproval: true
}

/** 把一条建议变成声明（或拒绝）的结果。 */
export interface CapabilitySuggestionApplication {
  readonly applied: boolean
  readonly reason: 'OWNER_CONFIRMED' | 'OWNER_CONFIRMATION_REQUIRED' | 'SUGGESTION_NOT_APPLICABLE' | 'UNKNOWN_SUGGESTION'
  readonly outbound: readonly ProvidedCapabilityAd[]
  readonly detail: string
}

/**
 * 跑完整的六步管线。
 *
 * 每一步的丢弃都进同一个账（`drops`），最后一次性算差集 —— 这样"丢了什么"只有一个出口，
 * 不会出现"某一步自己悄悄丢了、差集里看不见"的形状。
 * @param request - 本机清单、探测端口、平台镜像、主人策略与平台回读结果。
 * @returns 六步产物 + 差集 + 告警 + 风险。
 */
export async function runCapabilityDeclarationPipeline(request: CapabilityDeclarationRequest): Promise<CapabilityDeclarationReport> {
  // ① + ②
  const map = mapLocalItemsToContract(request.items)
  const drops: DeclarationDrop[] = map.unmapped.map(item => ({
    name: item.localId, stage: 'mapping' as const, reason: item.reason, detail: item.detail,
  }))

  // ④（先核名：核不过的名字不进探测，也不出站）
  const extraNames = (request.declaredNames ?? []).map(normalizeAdvertisedName)
  const preflight = checkDeclarationNames([...new Set([...map.capabilities, ...extraNames])], request.mirror)
  const accepted = preflight.filter(verdict => verdict.accepted).map(verdict => verdict.name)
  for (const verdict of preflight) {
    if (verdict.accepted) continue
    drops.push({ name: verdict.name, stage: 'preflight', reason: verdict.reason ?? 'UNKNOWN_CONTRACT_NAME', detail: verdict.detail })
  }

  // ③（只探测本机有映射来源的能力：真实调用有代价，也不许替 declaredNames 背书）
  const health = await probeCapabilityHealth(map.capabilities, request.health, request.signal)
  for (const refusal of healthRefusals(health)) {
    drops.push({ name: refusal.capability, stage: 'health', reason: refusal.reason, detail: refusal.detail })
  }
  for (const name of accepted) {
    if (map.capabilities.includes(name)) continue
    drops.push({
      name, stage: 'health', reason: 'NO_HEALTH_OBSERVATION',
      detail: `${name} 只出现在 declaredNames 里：本机没有任何映射来源，也没有它的最小真实调用 ⇒ 不许声明一个自己没有证据的能力（"自己开闸"就是这么回来的）。`,
    })
  }
  const candidates = candidateCapabilities(health)

  // ⑥
  const approvals = candidates.map(capability => decideCapabilityApproval(capability, request.ownerPolicy))
  for (const verdict of approvals) {
    if (verdict.decision === 'approved') continue
    drops.push({ name: verdict.capability, stage: 'owner', reason: verdict.reason, detail: verdict.detail })
  }
  const outboundNames = approvals.filter(verdict => verdict.decision === 'approved').map(verdict => verdict.capability).sort()
  const outbound: readonly ProvidedCapabilityAd[] = outboundNames.map(name => ({
    name, version: CAPABILITY_REGISTRY_VERSION, health: 'ok' as const,
  }))

  // ④（字段层）：平台会静默丢弃的键
  const fieldDrops = checkOutboundFields(request.outboundFields ?? [], request.mirror)
  for (const field of fieldDrops) {
    drops.push({ name: field.key, stage: 'platform', reason: field.reason, detail: field.detail })
  }

  // ⑤
  const difference = diffCapabilityDeclaration({ declared: outboundNames, acknowledged: request.acknowledged, priorDrops: drops })
  const alerts = [
    ...difference.dropped.map(drop => `${STAGE_LABEL[drop.stage]} · ${drop.name} · ${drop.reason} —— ${drop.detail}`),
    ...difference.unexpected.map(name =>
      `对不上账 · ${name} · PLATFORM_ACKNOWLEDGED_WITHOUT_DECLARATION —— 平台承认了本机没有声明的能力：要么本机声明面漏了一项，要么平台侧有残留，必须查清。`),
    ...(difference.platformReadback
      ? []
      : ['未回读 · platform-readback · PLATFORM_READBACK_MISSING —— 没有拿到平台回读 ⇒ 平台侧的丢弃这次不可见，不许把"没有差集"当成"平台全认了"。']),
  ]

  return {
    inventory: request.items,
    mapped: map.mapped,
    unmapped: map.unmapped,
    incompleteGroups: map.incompleteGroups,
    health,
    candidates,
    preflight,
    approvals,
    outbound,
    fieldDrops,
    acknowledged: difference.acknowledged,
    difference,
    alerts,
    requiresOwnerAttention: alerts.length > 0,
    risks: difference.platformReadback ? [...request.mirror.risks] : [...request.mirror.risks, NO_READBACK_RISK],
  }
}

/**
 * Scout：把丢弃翻译成"要主人做什么"的建议。
 *
 * 只产出建议 —— 本函数的返回类型里没有 `outbound`，从形状上就不给开闸的权力。
 * @param report - 六步管线的产物。
 * @returns 一条丢弃一条建议，外加（未回读时）一条恢复回读的建议。
 */
export function scoutCapabilitySuggestions(report: CapabilityDeclarationReport): readonly CapabilitySuggestion[] {
  const suggestions: CapabilitySuggestion[] = report.difference.dropped.map(drop => ({
    id: `${ACTION_BY_STAGE[drop.stage]}:${drop.name}`,
    capability: drop.name,
    actionable: ACTION_BY_STAGE[drop.stage],
    why: `${drop.reason}：${drop.detail}`,
    requiresOwnerApproval: true,
  }))
  if (!report.difference.platformReadback) {
    suggestions.push({
      id: 'report-to-platform:platform-readback',
      capability: 'platform-readback',
      actionable: 'report-to-platform',
      why: '平台没有回读：平台侧的丢弃不可见。建议恢复 worker 行的只读回读（或按手册退化为"本地镜像 + 定期核对"）后再核账。',
      requiresOwnerApproval: true,
    })
  }
  return suggestions
}

/**
 * 唯一能把建议变成声明的入口 —— 而且要求主人确认。
 *
 * 只有 `owner-confirm` 类建议可执行：名字/健康/映射类建议是**待办**，
 * Scout 不能替主人改名字、也不能替主人把没通过健康探测的能力报出去。
 * @param report - 六步管线的产物。
 * @param suggestionId - {@link CapabilitySuggestion.id}。
 * @param confirmation - 主人是否已经确认。
 * @returns 是否生效、原因、以及生效后的声明面（未生效时就是原样）。
 */
export function applyCapabilitySuggestion(
  report: CapabilityDeclarationReport,
  suggestionId: string,
  confirmation: { readonly ownerConfirmed: boolean },
): CapabilitySuggestionApplication {
  const suggestion = scoutCapabilitySuggestions(report).find(candidate => candidate.id === suggestionId)
  if (suggestion === undefined) {
    return { applied: false, reason: 'UNKNOWN_SUGGESTION', outbound: report.outbound, detail: `没有这个建议 id：${suggestionId}。` }
  }
  if (suggestion.actionable !== 'owner-confirm') {
    return {
      applied: false, reason: 'SUGGESTION_NOT_APPLICABLE', outbound: report.outbound,
      detail: `${suggestion.id} 是 ${suggestion.actionable} 类的待办，不是 Scout 能执行的动作：Scout 只产出建议，无开闸权。`,
    }
  }
  if (!confirmation.ownerConfirmed) {
    return {
      applied: false, reason: 'OWNER_CONFIRMATION_REQUIRED', outbound: report.outbound,
      detail: `${suggestion.capability} 已经通过核名与健康探测，只差主人逐条确认 ⇒ 确认前不出现在声明面里。`,
    }
  }
  const outbound = [...report.outbound, { name: suggestion.capability, version: CAPABILITY_REGISTRY_VERSION, health: 'ok' as const }]
    .sort((left, right) => (left.name < right.name ? -1 : 1))
  return { applied: true, reason: 'OWNER_CONFIRMED', outbound, detail: `${suggestion.capability} 已由主人确认，加入出站声明面。` }
}

/**
 * 把报告渲染成主人可读的一段文本（E9 的可见性出口直接贴它）。
 * @param report - 六步管线的产物。
 * @returns 分段文本：本机清单 / 映射 / 健康 / 核名 / 三档 / 出站 / 回读 / 差集 / 告警 / 风险。
 */
export function renderCapabilityDeclarationReport(report: CapabilityDeclarationReport): string {
  const lines: string[] = ['能力声明管线报告（节点侧 · 工单 8）']
  lines.push(`[本机清单] ${report.inventory.length} 项`)
  for (const item of report.inventory) lines.push(`  - ${item.kind} ${item.id}${item.capability === undefined ? '' : `（自报 ${item.capability}）`}`)

  lines.push(`[契约名映射] ${report.mapped.length} 条映射 / ${report.unmapped.length} 项未映射 / ${report.incompleteGroups.length} 个角色组缺口`)
  for (const row of report.mapped) lines.push(`  - ${row.localId} → ${row.capability}（${row.via}）`)
  for (const item of report.unmapped) lines.push(`  - 未映射项 ${item.localId} · ${item.reason} —— ${item.detail}`)
  for (const group of report.incompleteGroups) lines.push(`  - 角色组缺口 ${group.capability} · 缺 ${group.missingRoles.join('/')} —— ${group.detail}`)

  lines.push(`[健康探测] ${report.candidates.length} 项通过 / ${report.health.length - report.candidates.length} 项未通过`)
  for (const observation of report.health) {
    lines.push(`  - ${observation.capability} · ${observation.health}${observation.reason === null ? '' : ` · ${observation.reason}`} —— ${observation.detail}`)
  }

  const rejected = report.preflight.filter(verdict => !verdict.accepted)
  lines.push(`[声明前核名] ${report.preflight.length - rejected.length} 项通过 / ${rejected.length} 项不通过`)
  for (const verdict of rejected) lines.push(`  - ${verdict.name} · ${verdict.reason} —— ${verdict.detail}`)

  lines.push(`[主人三档] ${report.approvals.length} 项判定`)
  for (const verdict of report.approvals) lines.push(`  - ${verdict.capability} · ${verdict.tier} · ${verdict.decision} · ${verdict.reason}`)

  lines.push(`[出站声明] ${report.outbound.length} 项：${report.outbound.map(ad => ad.name).join(', ') || '（空）'}`)
  for (const field of report.fieldDrops) lines.push(`  - 出站字段 ${field.key} · ${field.reason} —— ${field.detail}`)

  lines.push(`[平台回读] ${report.acknowledged === null ? '未回读（平台侧丢弃不可见）' : `${report.acknowledged.length} 项：${report.acknowledged.join(', ') || '（空）'}`}`)

  lines.push(`[差集] declared ${report.difference.declared.length} / acknowledged ${report.difference.acknowledged === null ? '未知' : report.difference.acknowledged.length} / 丢弃 ${report.difference.dropped.length} / 多出 ${report.difference.unexpected.length}`)
  for (const drop of report.difference.dropped) lines.push(`  - ${drop.name} · ${drop.stage} · ${drop.reason} —— ${drop.detail}`)
  for (const name of report.difference.unexpected) lines.push(`  - 多出 ${name} · 平台承认了本机没声明的能力`)

  lines.push(`[告警] ${report.alerts.length} 条`)
  for (const alert of report.alerts) lines.push(`  - ${alert}`)

  lines.push(`[风险] ${report.risks.length} 条`)
  for (const risk of report.risks) lines.push(`  - ${risk}`)

  return lines.join('\n')
}
