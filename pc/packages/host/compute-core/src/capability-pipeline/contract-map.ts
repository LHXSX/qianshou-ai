/**
 * 工单 8 · 第 ①② 步：本机清单 → 平台契约能力 ID 的映射表（含**别名归一**与**未映射项清单**）。
 *
 * ## 为什么本模块的主角是"未映射清单"而不是"映射表"
 *
 * 实测现状：节点上报的是**固定清单**（`能力广告 · ["text.transform"]`），与"本机实际装了什么"
 * 没有自动映射。装了一个工具却不能报，对主人的表现是**永远没单，而且查不出原因**。
 *
 * 因此这里的设计规则是：**任何本机项如果没有契约名可落，都必须作为一条带原因的记录返回**，
 * 调用方不许 `filter` 掉它。反面证据就在契约注册表自己身上
 * （`contracts/v1/capabilities.registry.json` 的 `observed_unmapped_software`）：
 * 生产池里真实出现过 `tldextract`，以及节点广告的 `node/git/python3/ffprobe/bash` ——
 * 它们**不是能力**，是工具；把这层事实"记下来"与"悄悄丢掉"是两件事。
 *
 * ## 别名归一
 *
 * 归一规则来自注册表 v1（lowercase + hyphen-to-underscore），生产池里真实违反过一次
 * （某节点广告 `faster-whisper`，而平台 `required_software` 写的是 `faster_whisper`）。
 * 除归一之外，本模块还吃三类别名：
 * - **旧式裸名**（`word_count`、`video_compress`…）：平台 `hello_union_gate` 只认契约名，
 *   裸名会被剔除而节点自己不知道。这里把它们**主动归一到契约名**。
 * - **实现名**（`ffmpeg`、`PIL`、`pymupdf`…）：一个实现可以同时满足多个契约能力。
 * - **本机模型项**：归到 `llm.generate.local`，能否广告由第 ③ 步的最小真实自检决定。
 *
 * ## 角色组（AND）不许假装成立
 *
 * 注册表里 `web.extract` / `web.fetch` 的实现带 `role`（同角色之间是 OR，不同角色之间是 AND，
 * 见 `capability-registry.ts` 的 `CapabilityImplementationGroup` 语义）。只装了 `selectolax`
 * 时 `web.fetch` 并不成立 —— 这时候**不许**把它报出去（那会变成另一种静默的谎：
 * 报了却接不到单）。本模块把这种情况记成 `ROLE_GROUP_INCOMPLETE` 并写明**缺哪个角色**。
 */
import {
  CAPABILITY_BY_TASK_TYPE,
  IMPLEMENTATIONS_BY_CAPABILITY,
  SEMANTIC_CAPABILITY_NAMES,
} from '../capability-registry.ts'
import { softwareNamesProveCapability } from '../host-side-matching.ts'
import { capabilitiesSatisfiedByAdvertised } from '../node-capability.ts'

/** 本机清单里一类东西。`plugin`/`workflow` 由插件与工作流自报能力名。 */
export type LocalItemKind = 'plugin' | 'tool' | 'package' | 'model' | 'workflow'

/** 本机清单的一项。`capability` 是本机项自报的能力名（可能是契约名、旧式裸名或拼错的名字）。 */
export interface LocalCapabilityItem {
  /** 本机项 id（工具名 / 包名 / 插件 id / 模型 id / 工作流 id）。 */
  readonly id: string
  readonly kind: LocalItemKind
  /** 本机项自报自己供哪项能力；省略时只用 `id` 去映射表里找。 */
  readonly capability?: string
}

/** 一条映射成立的依据。`via` 决定主人是否还能继续追问"凭什么"。 */
export type MappingVia =
  | 'direct-contract-name'
  | 'legacy-task-type'
  | 'implementation'
  | 'set-completion'
  | 'executor-self-test'

/** 一项本机东西落到的契约能力，以及它是怎么落上去的。 */
export interface CapabilityMapping {
  readonly localId: string
  readonly localKind: LocalItemKind
  readonly capability: string
  readonly via: MappingVia
  readonly detail: string
}

/** 本机项落不到契约名上的原因。每一种都必须能被主人读懂，不许合并成"未知"。 */
export type UnmappedReason =
  | 'EMPTY_INVENTORY_ITEM'
  | 'MALFORMED_NAME'
  | 'NO_REGISTRY_IMPLEMENTATION'
  | 'ROLE_GROUP_INCOMPLETE'

/** **未映射项清单**的一行。存在本身就是本模块的价值：装了东西而报不出去，必须看得见。 */
export interface UnmappedLocalItem {
  readonly localId: string
  readonly localKind: LocalItemKind
  readonly reason: UnmappedReason
  readonly detail: string
}

/** 一个角色组没凑齐的契约能力：缺哪个角色、已有哪些角色。 */
export interface IncompleteImplementationGroup {
  readonly capability: string
  readonly missingRoles: readonly string[]
  readonly presentRoles: readonly string[]
  readonly detail: string
}

/** 第 ② 步的产物：映射结果 + 未映射清单 + 角色组缺口 + 去重后的契约能力名。 */
export interface ContractMapResult {
  readonly mapped: readonly CapabilityMapping[]
  readonly unmapped: readonly UnmappedLocalItem[]
  readonly incompleteGroups: readonly IncompleteImplementationGroup[]
  readonly capabilities: readonly string[]
}

/** 本机模型项今天只有一条来源（`local-probe.ts` 的 ollama 清单）⇒ 它对应的契约能力就是这一项。 */
const LOCAL_MODEL_CAPABILITY = 'llm.generate.local'

/** 归一后的可用名字形状：lowercase + 数字 + `_` + `.`。空格与中文都会在这里被拦下。 */
const USABLE_NAME_SHAPE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/

/**
 * 归一一个能力/实现/软件名（注册表 v1 规则：lowercase + hyphen-to-underscore）。
 * @param raw - 本机自报或注册表里的写法。
 * @returns 归一后的 token；纯空白输入返回空串。
 */
export function normalizeAdvertisedName(raw: string): string {
  return raw.trim().toLowerCase().replace(/-/g, '_')
}

/** 归一化拼写 → 它作为**旧式裸名**（没有点）时归属的契约能力。 */
const LEGACY_ALIAS_BY_SPELLING: Readonly<Record<string, string>> = (() => {
  const table: Record<string, string> = {}
  for (const [spelling, capability] of Object.entries(CAPABILITY_BY_TASK_TYPE)) {
    if (spelling.includes('.')) continue
    table[normalizeAdvertisedName(spelling)] = capability
  }
  return table
})()

/** 归一化实现名 → 它填上的角色（`capability` + 该实现声明的 `role`）。 */
const ROLES_BY_IMPLEMENTATION_NAME: Readonly<Record<string, readonly { readonly capability: string; readonly role: string }[]>> = (() => {
  const table: Record<string, { capability: string; role: string }[]> = {}
  for (const [capability, implementations] of Object.entries(IMPLEMENTATIONS_BY_CAPABILITY)) {
    for (const implementation of implementations) {
      if (implementation.role === null) continue
      for (const name of implementation.names) {
        const key = normalizeAdvertisedName(name)
        table[key] = [...(table[key] ?? []), { capability, role: implementation.role }]
      }
    }
  }
  return table
})()

/**
 * 带角色（AND 语义）且允许用软件名证明的契约能力 → 归一化实现名 → 该实现填的角色。
 * @returns 每个这样的能力所需的角色集合。
 */
function roledCapabilityRoles(): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const table: Record<string, Record<string, string>> = {}
  for (const [capability, implementations] of Object.entries(IMPLEMENTATIONS_BY_CAPABILITY)) {
    if (!softwareNamesProveCapability(capability)) continue
    const roles: Record<string, string> = {}
    for (const implementation of implementations) {
      if (implementation.role === null) continue
      for (const name of implementation.names) roles[normalizeAdvertisedName(name)] = implementation.role
    }
    if (Object.keys(roles).length > 0) table[capability] = roles
  }
  return table
}

/** 注册表是常量：角色表只在模块加载时算一次，探测循环里不再重复推导。 */
const ROLED_CAPABILITY_ROLES = roledCapabilityRoles()

/**
 * 把本机清单映射成平台契约能力，并把**落不下去的项**逐条列出来。
 *
 * 不推断、不编造：名字对不上就进未映射清单；角色组不满就进缺口清单；
 * 绝不用"看起来差不多"的办法把一项本机东西变成一条能力广告。
 * @param items - 本机真实清单项（工具/包/插件/模型/工作流）。
 * @returns 映射结果、未映射清单、角色组缺口与去重后的契约能力名（均已排序）。
 */
export function mapLocalItemsToContract(items: readonly LocalCapabilityItem[]): ContractMapResult {
  const mapped: CapabilityMapping[] = []
  const unmapped: UnmappedLocalItem[] = []
  const roleContributors: { readonly item: LocalCapabilityItem; readonly contributions: readonly { readonly capability: string; readonly role: string }[] }[] = []

  for (const item of items) {
    const spelled = item.capability ?? item.id
    const name = normalizeAdvertisedName(spelled)
    const base = { localId: item.id, localKind: item.kind }

    if (name === '') {
      unmapped.push({ ...base, reason: 'EMPTY_INVENTORY_ITEM', detail: '本机项没有可用于映射的名字（id 与自报能力都为空）。' })
      continue
    }
    if (item.kind === 'model') {
      mapped.push({
        ...base, capability: LOCAL_MODEL_CAPABILITY, via: 'executor-self-test',
        detail: `本机模型 ${spelled} ⇒ ${LOCAL_MODEL_CAPABILITY}：模型清单只能证明"装了"，能否广告由第 ③ 步的最小真实推理自检决定。`,
      })
      continue
    }
    if (!USABLE_NAME_SHAPE.test(name)) {
      unmapped.push({
        ...base, reason: 'MALFORMED_NAME',
        detail: `"${spelled}" 归一后仍不是可用名字：期望 lowercase + 下划线，能力名再带点（<domain>.<object>.<action>）。`,
      })
      continue
    }
    if (SEMANTIC_CAPABILITY_NAMES.includes(name)) {
      mapped.push({ ...base, capability: name, via: 'direct-contract-name', detail: `本机项已经写的就是契约名 ${name}，按原样收下。` })
      continue
    }
    const legacy = LEGACY_ALIAS_BY_SPELLING[name]
    if (legacy !== undefined) {
      mapped.push({
        ...base, capability: legacy, via: 'legacy-task-type',
        detail: `"${spelled}" 是平台的旧式任务类型写法，归一为契约名 ${legacy}（平台 hello_union_gate 只放行契约名，裸名会被剔除）。`,
      })
      continue
    }
    const alone = capabilitiesSatisfiedByAdvertised([name])
    if (alone.length > 0) {
      for (const capability of alone) {
        mapped.push({ ...base, capability, via: 'implementation', detail: `实现 ${spelled} 单独即可满足 ${capability}（注册表实现名匹配）。` })
      }
      continue
    }
    const contributions = ROLES_BY_IMPLEMENTATION_NAME[name]
    if (contributions !== undefined && contributions.length > 0) {
      roleContributors.push({ item, contributions })
      continue
    }
    unmapped.push({
      ...base, reason: 'NO_REGISTRY_IMPLEMENTATION',
      detail: `注册表里没有任何契约能力或实现匹配 "${spelled}"：它是本机工具/包，不是能力（注册表的 observed_unmapped_software 记着同一类事实：node/git/python3/ffprobe/bash 与 tldextract）。`,
    })
  }

  // 角色组：单看一项不算数，要看整个清单能不能把同一能力的每个角色都填满。
  const advertised = new Set(items.map(item => normalizeAdvertisedName(item.capability ?? item.id)))
  const satisfiedSet = new Set(capabilitiesSatisfiedByAdvertised(advertised))
  const rolesByCapability = ROLED_CAPABILITY_ROLES

  for (const contributor of roleContributors) {
    const complete = contributor.contributions.filter(contribution => satisfiedSet.has(contribution.capability))
    if (complete.length === 0) {
      unmapped.push({
        localId: contributor.item.id, localKind: contributor.item.kind, reason: 'ROLE_GROUP_INCOMPLETE',
        detail: `本机项补齐了角色 ${contributor.contributions.map(contribution => contribution.role).join('/')}，但对应角色组没凑齐 ⇒ 该能力不成立（同角色之间是 OR、不同角色之间是 AND）。缺口见 incompleteGroups。`,
      })
      continue
    }
    for (const contribution of complete) {
      mapped.push({
        localId: contributor.item.id, localKind: contributor.item.kind, capability: contribution.capability, via: 'set-completion',
        detail: `本机项填上 ${contribution.capability} 的角色 ${contribution.role}；该能力需要同组角色全部到位，本机清单已凑齐。`,
      })
    }
  }

  const incompleteGroups: IncompleteImplementationGroup[] = []
  for (const [capability, roles] of Object.entries(rolesByCapability)) {
    const presentRoles = [...new Set(Object.entries(roles).filter(([name]) => advertised.has(name)).map(([, role]) => role))].sort()
    const missingRoles = [...new Set(Object.values(roles))].filter(role => !presentRoles.includes(role)).sort()
    if (presentRoles.length === 0 || missingRoles.length === 0) continue
    incompleteGroups.push({
      capability, missingRoles, presentRoles,
      detail: `${capability} 需要角色组全部到位：本机有 ${presentRoles.join('/')}，缺 ${missingRoles.join('/')} ⇒ 不报这项能力（报了也接不到单）。`,
    })
  }

  const byLocalId = (left: { readonly localId: string }, right: { readonly localId: string }): number =>
    left.localId < right.localId ? -1 : left.localId > right.localId ? 1 : 0

  return {
    mapped: [...mapped].sort((left, right) => byLocalId(left, right) || (left.capability < right.capability ? -1 : 1)),
    unmapped: [...unmapped].sort(byLocalId),
    incompleteGroups: [...incompleteGroups].sort((left, right) => (left.capability < right.capability ? -1 : 1)),
    capabilities: [...new Set(mapped.map(row => row.capability))].sort(),
  }
}
