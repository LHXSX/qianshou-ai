/**
 * 工单 8 · 第 ④ 步：平台注册表镜像 + 声明前核名（"核不过 ⇒ 不发 + 明确告警"）。
 *
 * ## 平台侧有两道互不相干的静默闸，本模块把两道都变成节点侧可自查的核名
 *
 * 1. **字段白名单**（`storage/repo.py:1811-1814`）：`_worker_capabilities` 只留
 *    `WorkerCapabilities` dataclass 声明过的键，`{k: v for k, v in kwargs.items() if k in allowed}`
 *    —— 多报的键**无声丢弃**，无报错、无日志、注册照常成功。
 *    实测事故：本仓把 `native_binaries` 写成 `native_bins`，整块 native 二进制清单在注册与心跳
 *    两条路径上都被丢掉，**错名活了两个月**，两侧测试全绿。
 * 2. **契约名闸**（`services/capability_shadow.py:252` `hello_union_gate`）：只放行
 *    `provided_capabilities` 里**健康广告了该契约名**的节点。实测事故：某在线节点报旧式裸名
 *    `["word_count", …]` ⇒ 被剔除，**节点自己不知道**。
 *
 * ## 降级模式（本工单的边界，必须自述）
 *
 * 手册允许的退化路径是"本地镜像 + 定期核对"：本仓没有平台的只读接口，
 * 所以镜像取自 ① `contracts/v1/capabilities.registry.json`（能力名全集与旧式任务类型），
 * ② 一次真实 worker 行抓取（`docs/dev-plan/evidence/双机验收/AT-08.json`，2026-09-17）的字段集。
 * 镜像**可能落后于线上平台**，凡"镜像里有、平台已改名"的名字本模块不会报警 ——
 * 这条风险写在 {@link PlatformRegistryMirror.risks} 里随报告一起给主人看，不藏在注释里。
 */
import {
  CAPABILITY_BY_TASK_TYPE,
  IMPLEMENTATIONS_BY_CAPABILITY,
  LEGACY_TASK_TYPES_BY_CAPABILITY,
  SEMANTIC_CAPABILITY_NAMES,
} from '../capability-registry.ts'
import { normalizeAdvertisedName } from './contract-map.ts'

/**
 * 平台 `WorkerCapabilities` dataclass 声明过的字段集（47 个），来自一次**真实 worker 行抓取**。
 *
 * 为什么是抓取值而不是抄平台源码：抓到的行是平台白名单的**输出**，所以其中每个键按构造都
 * 是 dataclass 声明过的字段 —— 这比"我以为 dataclass 长这样"强。
 * - 来源：`docs/dev-plan/evidence/双机验收/AT-08.json`（`observed.steps[1].capabilities`）
 * - 抓取时间：2026-09-17T05:36:48.802Z
 * - 交叉核对：`tests/capability-pipeline/registry-mirror.spec.ts` 断言本数组与契约测试夹具
 *   `tests/fixtures/platform-worker-capabilities.ts` 逐字一致 —— 重复的清单必须是
 *   **被检查的重复**，不是第三份静默副本。
 *
 * 本数组**不证明完整**：某个只有另一代客户端才会填充的 dataclass 字段不会出现在这次抓取里，
 * 那种情况下本模块会误报一个平台其实会保留的键。这是安全的错向（误报而非漏报）。
 */
export const PLATFORM_WORKER_CAPABILITY_FIELD_KEYS: readonly string[] = Object.freeze([
  'accelerators', 'ai_runtime_ready', 'arch', 'bench_capability_score', 'bench_cpu_mb_per_sec',
  'bench_disk_mb_per_sec', 'bench_memory_gb_per_sec', 'client_build', 'contribute_mode', 'cpu_brand',
  'cpu_cores', 'cpu_threads', 'device_name', 'equipped_models', 'free_disk_mb', 'gpu_count',
  'gpu_model', 'hostname', 'installed_apps', 'installed_skills', 'kernel_version', 'llm_backend',
  'llm_models', 'memory_gb', 'model_health', 'native_binaries', 'ollama_models', 'onnx_models', 'os',
  'os_name', 'os_version', 'protocol_capabilities', 'protocol_legacy', 'protocol_profile',
  'protocol_profile_observations', 'provided_capabilities', 'ram_gb', 'runtime_tiers', 'runtimes',
  'software', 'specialty', 'supported_executors', 'throttle_pct', 'tier', 'total_disk_mb',
  'total_memory_mb', 'vram_mb',
])

/** 抓取来源与时间：与契约测试夹具同源，供报告自述与人工复核。 */
export const PLATFORM_CAPABILITY_CAPTURE_SOURCE = 'docs/dev-plan/evidence/双机验收/AT-08.json (observed.steps[1].capabilities)'
export const PLATFORM_CAPABILITY_CAPTURED_AT = '2026-09-17T05:36:48.802Z'

/**
 * 已经真实发生过、并且造成过损失的键名错写。
 *
 * 为什么不靠编辑距离自动发现：`native_bins` ↔ `native_binaries` 的编辑距离是 4，
 * 任何"距离 ≤ 2"的模糊匹配都抓不到它 —— 于是它会**再活两个月**。这里把事故本身记成规则，
 * 泛化的近似匹配只作为第二道网（`MISSPELLED_PLATFORM_FIELD` 的另一条路径）。
 */
const RECORDED_FIELD_MISSPELLINGS: Readonly<Record<string, string>> = Object.freeze({
  native_bins: 'native_binaries',
})

/** 平台字段白名单里没有它、但**不是**拼错（登记为客户端专属键）的键，见契约测试的 `KNOWN_CLIENT_ONLY_KEYS`。 */
const RECORDED_CLIENT_ONLY_KEYS: readonly string[] = Object.freeze(['mode', 'uptime_sec'])

/** 契约名形状：`<domain>.<object>.<action>`。旧式裸名（无点）也放行走后面的分类分支。 */
const CONTRACT_NAME_SHAPE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/

/** 平台注册表的一个本地镜像。字段都是"可复核的事实"，不是推断。 */
export interface PlatformRegistryMirror {
  /** `local-mirror` 是退化模式：本仓拿不到平台只读接口，镜像可能落后。 */
  readonly kind: 'live-readonly' | 'local-mirror'
  readonly contract: string
  readonly version: string
  /** 抓取时间（不是本模块运行时间），与 `captureSource` 配套。 */
  readonly capturedAt: string
  readonly captureSource: string
  /** 本模块读这份镜像的时刻，用于"定期核对"的落款。 */
  readonly mirrorCheckedAt: string
  /** 注册表里的全部契约能力名（含没有软件实现的那些）。 */
  readonly capabilityIds: readonly string[]
  /** 平台记录的旧式 `task_type` 写法：它们**不是**契约名。 */
  readonly legacyTaskTypes: readonly string[]
  /** 旧式写法 / 契约名 → 契约能力名。 */
  readonly capabilityByTaskType: Readonly<Record<string, string>>
  /** 平台 `WorkerCapabilities` 字段白名单。 */
  readonly workerCapabilityFieldKeys: readonly string[]
  /** 本镜像的已知风险（含"可能落后于线上平台"），随报告一起给主人看。 */
  readonly risks: readonly string[]
}

/**
 * 建立平台注册表的本地镜像（退化模式）。
 * @param options - `now` 只用于给这次核对落款；`kind` 允许调用方显式声明拿到的是在线只读快照。
 * @returns 一份可复核的镜像，风险自述齐全。
 */
export function localRegistryMirror(options: { readonly now?: Date; readonly kind?: 'live-readonly' | 'local-mirror' } = {}): PlatformRegistryMirror {
  const kind = options.kind ?? 'local-mirror'
  return {
    kind,
    contract: 'qianshou/capabilities/registry/v1',
    version: '1.0',
    capturedAt: PLATFORM_CAPABILITY_CAPTURED_AT,
    captureSource: PLATFORM_CAPABILITY_CAPTURE_SOURCE,
    mirrorCheckedAt: (options.now ?? new Date()).toISOString(),
    capabilityIds: [...SEMANTIC_CAPABILITY_NAMES].sort(),
    legacyTaskTypes: [...new Set(Object.values(LEGACY_TASK_TYPES_BY_CAPABILITY).flat())].sort(),
    capabilityByTaskType: CAPABILITY_BY_TASK_TYPE,
    workerCapabilityFieldKeys: PLATFORM_WORKER_CAPABILITY_FIELD_KEYS,
    risks: [
      '平台注册表只有本地镜像：本仓拿不到平台的只读接口，镜像是"契约注册表 + 一次真实 worker 行抓取（2026-09-17）"。'
        + '镜像里有、线上平台已改名的名字不会被本管线点名 ⇒ 必须定期核对（这是本工单明示的退化模式）。',
      '契约注册表自己记着一条**待对账**项：平台 `engine/capabilities.py` 用的是 `doc.pdf.text`，'
        + '本注册表用的是 `doc.pdf.extract`。对账前不得假定其中任一个是权威（注册表 open_questions）。',
      '字段白名单只证明"平台声明过的键不会被丢"，**不证明这份清单完整**：'
        + '某代客户端才填充的字段可能不在抓取里，那会让本模块误报一个平台其实保留的键（安全的错向）。',
    ],
  }
}

/** 名字核不过的原因。每一类都要能被主人读懂，并且与"名字拼错"区分开。 */
export type DeclarationNameRejectionReason =
  | 'MALFORMED_CONTRACT_NAME'
  | 'LEGACY_TASK_TYPE_NAME'
  | 'IMPLEMENTATION_NAME_NOT_A_CAPABILITY'
  | 'PLATFORM_FIELD_NOT_A_CAPABILITY'
  | 'MISSPELLED_PLATFORM_FIELD'
  | 'UNKNOWN_CONTRACT_NAME'

/** 一个待声明名字的核名结论。`accepted` 为 false 时**不许发出去**。 */
export interface DeclarationNameVerdict {
  readonly name: string
  readonly accepted: boolean
  readonly reason: DeclarationNameRejectionReason | null
  /** 平台侧的纠正建议（合法契约名或合法字段名）；说不出来就是 null，不编造。 */
  readonly suggestion: string | null
  readonly detail: string
}

/** 出站字段会被平台静默丢弃的原因。 */
export type OutboundFieldDropReason = 'MISSPELLED_PLATFORM_FIELD' | 'NOT_DECLARED_BY_PLATFORM_WHITELIST'

/** 一个会被平台白名单**无声丢弃**的出站字段。存在本身就是"静默丢弃可见化"。 */
export interface OutboundFieldDrop {
  readonly key: string
  readonly reason: OutboundFieldDropReason
  readonly suggestion: string | null
  readonly detail: string
}

/**
 * Levenshtein 距离（两个短字符串，只用于名字建议）。
 * @param left - 左串。
 * @param right - 右串。
 * @returns 编辑距离。
 */
function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0]!
    previous[0] = row
    for (let column = 1; column <= right.length; column += 1) {
      const carried = previous[column]!
      previous[column] = left[row - 1] === right[column - 1]
        ? diagonal
        : 1 + Math.min(diagonal, previous[column]!, previous[column - 1]!)
      diagonal = carried
    }
  }
  return previous[right.length]!
}

/**
 * 在候选里找与 `name` 最近的一个（用于"你是不是想写 X"）。
 * @param name - 归一化后的名字。
 * @param candidates - 候选集。
 * @param maxDistance - 超过它就不给建议（宁可不说，也不编造）。
 * @returns 最近候选，或 null。
 */
function nearestCandidate(name: string, candidates: readonly string[], maxDistance: number): string | null {
  let best: string | null = null
  let bestDistance = maxDistance + 1
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate)
    if (distance < bestDistance || (distance === bestDistance && best !== null && candidate < best)) {
      bestDistance = distance
      best = candidate
    }
  }
  return bestDistance <= maxDistance ? best : null
}

/** 归一化实现名 → 它归属的契约能力（**全部**，因为一个实现常常同时满足多项）。 */
function implementationCapabilities(name: string): readonly string[] {
  const owners: string[] = []
  for (const [capability, implementations] of Object.entries(IMPLEMENTATIONS_BY_CAPABILITY)) {
    if (implementations.some(implementation => implementation.names.some(candidate => normalizeAdvertisedName(candidate) === name))) {
      owners.push(capability)
    }
  }
  return owners.sort()
}

/**
 * 对一个**打算发出去的能力名**做声明前核名。
 *
 * 判据只认平台注册表里的契约名：旧式裸名、实现包名、平台字段名都不是契约名，
 * 而它们被发出去的后果是"被 hello_union_gate 剔除而节点自己不知道"。
 * @param names - 归一前的能力名列表（可以是任何写法）。
 * @param mirror - 平台注册表镜像。
 * @returns 与输入同序的核名结论；每个名字都有自己的原因与建议。
 */
export function checkDeclarationNames(names: readonly string[], mirror: PlatformRegistryMirror): readonly DeclarationNameVerdict[] {
  return names.map((raw): DeclarationNameVerdict => {
    const name = normalizeAdvertisedName(raw)
    if (name === '' || !CONTRACT_NAME_SHAPE.test(name)) {
      return {
        name, accepted: false, reason: 'MALFORMED_CONTRACT_NAME', suggestion: null,
        detail: `"${raw}" 不是可用的能力名：平台契约名形如 <domain>.<object>.<action>（如 ocr.image）。`,
      }
    }
    if (mirror.capabilityIds.includes(name)) {
      return { name, accepted: true, reason: null, suggestion: null, detail: `${name} 在平台注册表里，按契约名放行。` }
    }
    const legacyOwner = mirror.capabilityByTaskType[name]
    if (mirror.legacyTaskTypes.includes(name) && legacyOwner !== undefined) {
      return {
        name, accepted: false, reason: 'LEGACY_TASK_TYPE_NAME', suggestion: legacyOwner,
        detail: `"${name}" 是平台的旧式任务类型写法，不是契约名：平台 hello_union_gate（services/capability_shadow.py:252）只放行契约名，`
          + `旧式裸名会被剔除而节点自己不知道（真实事故②）。请改发 ${legacyOwner}。`,
      }
    }
    if (mirror.workerCapabilityFieldKeys.includes(name)) {
      return {
        name, accepted: false, reason: 'PLATFORM_FIELD_NOT_A_CAPABILITY', suggestion: null,
        detail: `"${name}" 是平台 WorkerCapabilities 的**字段名**，不是能力名：它该出现在档案的键上，不该出现在 provided_capabilities 里。`,
      }
    }
    const recorded = RECORDED_FIELD_MISSPELLINGS[name]
    if (recorded !== undefined) {
      return {
        name, accepted: false, reason: 'MISSPELLED_PLATFORM_FIELD', suggestion: recorded,
        detail: `"${name}" 是平台字段 ${recorded} 的错写（真实事故①，错名活了两个月）：它既不是能力名，也会被字段白名单静默丢弃。`,
      }
    }
    const owners = implementationCapabilities(name)
    if (owners.length > 0) {
      // ffmpeg 一项就覆盖 5 个契约能力：这时候给出"一个"建议就是编造，只能说清它归属哪几项。
      return {
        name, accepted: false, reason: 'IMPLEMENTATION_NAME_NOT_A_CAPABILITY',
        suggestion: owners.length === 1 ? owners[0]! : null,
        detail: `"${name}" 是包/实现名，不是能力名：平台按语义能力匹配（名字里不许出现厂商或包名）。`
          + (owners.length === 1
            ? `它归属契约能力 ${owners[0]!}。`
            : `它同时满足 ${owners.length} 个契约能力（${owners.join(', ')}）⇒ 请按你要广告的那一项（或几项）分别写契约名，本模块不给"选一个"的建议。`),
      }
    }
    const suggestion = nearestCandidate(name, mirror.capabilityIds, 2)
    return {
      name, accepted: false, reason: 'UNKNOWN_CONTRACT_NAME', suggestion,
      detail: `平台注册表里没有 "${name}"：发出去不会报错，只会被准入闸静默剔除（"报错了不报错"）。`
        + (suggestion === null ? '注册表里也没有名字相近的契约名可建议 —— 这项能力需要先在契约注册表里登记。' : `最近的一个是 ${suggestion}，请确认是不是它。`),
    }
  })
}

/**
 * 检查出站档案的字段键是否会被平台白名单**无声丢弃**。
 *
 * 这是事故①（`native_bins` vs `native_binaries`）在**字段层**的回归闸：错误不在名字的语义上，
 * 而在于平台根本没有这个键，于是整块信息消失且注册照常成功。
 * @param keys - 出站档案（hello/心跳）会带的字段键。
 * @param mirror - 平台注册表镜像（提供字段白名单）。
 * @returns 会被丢弃的字段，按字段名排序；清空表示这次出站面全部落在白名单内。
 */
export function checkOutboundFields(keys: readonly string[], mirror: PlatformRegistryMirror): readonly OutboundFieldDrop[] {
  const drops: OutboundFieldDrop[] = []
  for (const key of [...keys].sort()) {
    if (mirror.workerCapabilityFieldKeys.includes(key)) continue
    const recorded = RECORDED_FIELD_MISSPELLINGS[key]
    if (recorded !== undefined) {
      drops.push({
        key, reason: 'MISSPELLED_PLATFORM_FIELD', suggestion: recorded,
        detail: `平台 WorkerCapabilities 白名单里没有 "${key}" —— 它会被 storage/repo.py:1811-1814 无声丢弃（无报错、无日志、注册照常成功）。`
          + `平台真正读的名字是 ${recorded}（storage/repo.py:1892 / engine/planner.py:925 / services/workers/heartbeat.py:78,109）。`,
      })
      continue
    }
    const near = nearestCandidate(key, mirror.workerCapabilityFieldKeys, 2)
    if (near !== null) {
      drops.push({
        key, reason: 'MISSPELLED_PLATFORM_FIELD', suggestion: near,
        detail: `"${key}" 不在平台白名单里，但和平台声明的 ${near} 只差一点 ⇒ 很可能是拼错，会被静默丢弃。`,
      })
      continue
    }
    drops.push({
      key, reason: 'NOT_DECLARED_BY_PLATFORM_WHITELIST', suggestion: null,
      detail: RECORDED_CLIENT_ONLY_KEYS.includes(key)
        ? `"${key}" 是登记过的客户端专属键（平台不声明、不持久化它）：不会被平台读走，这是已知且有意保留的分歧。`
        : `平台 WorkerCapabilities 白名单里没有 "${key}" ⇒ 平台会静默丢弃它（无报错、无日志、注册照常成功）；要么改名，要么从出站面去掉。`,
    })
  }
  return drops
}
