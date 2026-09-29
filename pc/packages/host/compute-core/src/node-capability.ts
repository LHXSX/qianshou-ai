/**
 * 派单能力投影：把本机探测结果投影成调度中心 `hello` 帧的 `capabilities` 契约。
 *
 * 背景（2026-09-15 实测）
 * 上游 `platform_v8/protocol/ws_schema.py:42` 的 `HelloPayload.capabilities` 是一个
 * `dict[str, Any]`，由 `services/workers/register` 落库为节点的能力档案；派单侧据此
 * 判断节点能否承接某类任务。
 *
 * 我方初版把 `capabilities` 填成了 `{ word_count: '1.0.0' }` —— **字段名与上游完全对不上**，
 * 于是平台把节点解析成 `cpu_cores: 0 / runtimes: []`，派单视角里该节点不可用。
 * 真实节点（平台上已注册的 Mac 节点，实测取样）上报的形状是：
 *
 * ```json
 * { "os": "macos", "arch": "aarch64", "mode": "active", "tier": "basic",
 *   "os_name": "Darwin", "os_version": "26.5.2", "hostname": "…", "device_name": "…",
 *   "cpu_brand": "Apple M4", "cpu_cores": 10, "cpu_threads": 10,
 *   "runtimes": ["python3", "bash", "node"],
 *   "software": ["ffmpeg", "numpy", …],
 *   "native_binaries": ["curl", "ffmpeg", "tesseract", …],
 *   "gpu_count": 1, "gpu_model": "Apple Silicon (Metal + MLX)", "vram_mb": 12288,
 *   "llm_models": [], "llm_backend": "llama_cpp", "uptime_sec": 2178910,
 *   "memory_gb": 16.0, "total_memory_mb": 16384 }
 * ```
 *
 * 本模块只做**忠实的字段映射**：探测不到的事实一律留空或省略，绝不编造。
 *
 * 字段名不是本模块的自由选择：平台的 `WorkerCapabilities` 白名单会**静默丢弃**它没声明的键
 * （`storage/repo.py:1811-1814`，无报错、无日志、注册照常成功）。上面形状里的
 * `native_binaries` 曾经在本模块被写成 `native_bins`，于是整份 native 二进制清单在注册与心跳
 * 两条路径上都被无声丢掉，而所有测试依旧全绿 —— 这就是 `tests/node-capability-contract.spec.ts`
 * 存在的原因：它把平台字段集钉成夹具，任何本模块发出的键都必须落在该集合内。
 */
import { statfsSync } from 'node:fs'
import { homedir, hostname, platform, arch, release, totalmem, uptime } from 'node:os'
import { join } from 'node:path'
import type { SupplyProbeResult } from './supply/types.ts'
import { softwareNamesProveCapability } from './host-side-matching.ts'
import {
  CAPABILITY_REGISTRY_VERSION,
  IMPLEMENTATIONS_BY_CAPABILITY,
  SEMANTIC_CAPABILITY_NAMES,
} from './capability-registry.ts'

/** One `provided_capabilities` element: a registry capability this node satisfies. */
export interface ProvidedCapabilityAd {
  /** Registry capability id (`<domain>.<object>.<action>`), never a package or task_type name. */
  readonly name: string
  /** `CAPABILITY_REGISTRY_VERSION` of the projection that produced this ad. */
  readonly version: string
  /** Only `'ok'`: unproven capabilities are omitted rather than advertised as degraded. */
  readonly health: 'ok'
}

/**
 * Lowercase a software name and map `-` to `_`, matching the v1 registry normalisation note.
 * @param name - Raw advertised or registry spelling.
 * @returns Normalised token; empty input stays empty.
 */
function normalizeSoftwareName(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, '_')
}

/**
 * Registry capabilities eligible for installed-software matching.
 * Same `role` is OR; different roles are AND; all-unroled is OR.
 * This preserves installation evidence, not executor readiness. Inference
 * capabilities require an executor self-test and cannot match software names.
 * @param advertised - Package and native-binary names this node reported.
 * @returns Sorted capability ids. Empty advertised → empty result.
 */
export function capabilitiesSatisfiedByAdvertised(advertised: Iterable<string>): readonly string[] {
  const ads = new Set([...advertised].map(normalizeSoftwareName).filter(name => name.length > 0))
  const anyHit = (group: readonly { readonly names: readonly string[] }[]): boolean =>
    group.some(entry => entry.names.some(name => ads.has(normalizeSoftwareName(name))))
  return Object.keys(IMPLEMENTATIONS_BY_CAPABILITY)
    .filter((capability) => {
      if (!softwareNamesProveCapability(capability)) return false
      const impls = IMPLEMENTATIONS_BY_CAPABILITY[capability] ?? []
      const byRole = new Map<string, typeof impls>()
      const unroled: (typeof impls)[number][] = []
      for (const impl of impls) {
        if (impl.role === null) unroled.push(impl)
        else byRole.set(impl.role, [...(byRole.get(impl.role) ?? []), impl])
      }
      if (byRole.size > 0) return [...byRole.values()].every(anyHit)
      return anyHit(unroled)
    })
    .sort()
}

/**
 * Software and native-binary names a probe can prove, without reading host identity.
 * @param probe - Local supply observation.
 * @returns Deduplicated advertised names (binaries plus verified packages); empty when nothing verified.
 */
export function advertisedNamesFromProbe(probe: SupplyProbeResult): readonly string[] {
  const names = probe.localServices
    .filter(service => service.verification === 'verified' && (service.kind === 'tool' || service.kind === 'package'))
    .map(service => SOFTWARE_ALIASES[service.id] ?? service.id)
  return [...new Set(names)]
}

/**
 * Dual-write payload: registry capabilities this node can prove, as platform objects.
 * @param advertised - Union of `software` and `native_binaries`.
 * @returns `{name,version,health}` ads; never package names or legacy task types.
 */
function providedCapabilityAds(advertised: Iterable<string>): readonly ProvidedCapabilityAd[] {
  return capabilitiesSatisfiedByAdvertised(advertised).map(name => ({
    name,
    version: CAPABILITY_REGISTRY_VERSION,
    health: 'ok' as const,
  }))
}

/**
 * `{name,version,health}` ads for already-proven registry ids.
 * Unknown or landing names are dropped; this does not infer from packages.
 * @param ids - Registry capability ids a caller already proved.
 * @returns Sorted ads. Empty when no id is a registry semantic name.
 */
export function providedCapabilityAdsForIds(ids: Iterable<string>): readonly ProvidedCapabilityAd[] {
  return [...new Set(ids)]
    .filter(id => SEMANTIC_CAPABILITY_NAMES.includes(id))
    .sort()
    .map(name => ({
      name,
      version: CAPABILITY_REGISTRY_VERSION,
      health: 'ok' as const,
    }))
}

/**
 * Union capability ads by `name`. Later groups replace an earlier ad with the same name.
 * @param groups - Probe-derived ads, then runner-owned ads, or any other proven groups.
 * @returns Sorted unique ads. Names absent from the registry are dropped.
 */
export function mergeProvidedCapabilityAds(
  ...groups: readonly (readonly ProvidedCapabilityAd[])[]
): readonly ProvidedCapabilityAd[] {
  const byName = new Map<string, ProvidedCapabilityAd>()
  for (const group of groups) {
    for (const ad of group) {
      if (!SEMANTIC_CAPABILITY_NAMES.includes(ad.name)) continue
      byName.set(ad.name, ad)
    }
  }
  return [...byName.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/** 一个节点上报给调度中心的能力档案；字段名与上游 `we_workers.capabilities` 对齐。 */
/**
 * 虚拟/软件显示适配器：**它们不是可用来算的 GPU**。
 *
 * 实测过的真实例子：装了 **RTX 5080 Laptop（16GB）** 的 Windows 机器，
 * 因为枚举顺序把 `GameViewer Virtual Display Adapter`（远程串流工具的虚拟显示器）
 * 排在真卡前面，上报出去的就成了那块虚拟适配器，**真卡与显存从未被报出**。
 * 于是调度侧的"按能力匹配节点"根本看不到这台机器有 GPU。
 *
 * 覆盖范围：串流/投屏（GameViewer、Parsec、Sunshine、spacedesk）、
 * 虚拟显示器驱动（IDD、Virtual Display）、远程会话适配器，
 * 以及不带硬件加速的基础渲染驱动（Basic Render / DisplayLink）。
 */
const VIRTUAL_ADAPTER_PATTERN = /gameviewer|virtual|remote|parsec|sunshine|spacedesk|idd\b|basic render|displaylink|meta quest/i

export interface NodeCapabilityProfile {
  readonly os: string
  readonly arch: string
  readonly mode: string
  readonly tier: string
  readonly os_name: string
  readonly os_version: string
  readonly hostname: string
  readonly device_name: string
  readonly cpu_brand: string
  readonly cpu_cores: number
  readonly cpu_threads: number
  readonly runtimes: readonly string[]
  readonly software: readonly string[]
  /**
   * Native binaries this node may invoke directly.
   *
   * Named `native_binaries` because that is the field the platform actually declares and reads —
   * `storage/repo.py:1892` (`caps.get("native_binaries")`), `engine/planner.py:925` and
   * `services/workers/heartbeat.py:78,109`. It was sent as `native_bins` until 2026-09-18, a name
   * no platform file mentions, so the whitelist above dropped it without a word.
   */
  readonly native_binaries: readonly string[]
  /**
   * Semantic capabilities this node can prove from advertised software / native binaries,
   * as `{name,version,health}` objects the platform V2 matcher accepts.
   * `software` remains the old package-name advertisement; this field is the dual-write.
   *
   * 它是平台准入闸唯一读的字段，因此也是**唯一**的广告面：调用方可以通过
   * `options.providedCapabilities` 把它交给能力声明管线（映射 → 健康探测 → 核名 → 主人三档）
   * 决定，而不是让本函数按软件名自己推断。
   */
  readonly provided_capabilities: readonly ProvidedCapabilityAd[]
  readonly gpu_count: number
  readonly gpu_model: string
  readonly vram_mb: number
  readonly llm_models: readonly string[]
  readonly llm_backend: string
  readonly uptime_sec: number
  readonly memory_gb: number
  readonly total_memory_mb: number
  /**
   * Filesystem the host would stage attempts on, in MB. Omitted when unmeasured — the platform's
   * own defaults show these two keys, and a missing key stays "unknown" instead of becoming 0,
   * which a scheduler would read as "no disk".
   */
  readonly total_disk_mb?: number
  readonly free_disk_mb?: number
}

/** 上游 `os` 字段用的是短名，不是 Node 的 `process.platform`。 */
const OS_SHORT_NAME: Readonly<Record<string, string>> = {
  darwin: 'macos',
  win32: 'windows',
  linux: 'linux',
}

/** 上游 `arch` 用的是 `x86_64` / `aarch64` 这套，不是 Node 的 `x64` / `arm64`。 */
const ARCH_NAME: Readonly<Record<string, string>> = {
  x64: 'x86_64',
  arm64: 'aarch64',
  ia32: 'x86',
}

/** 探测到的工具名与上游 `software` 清单的差异修正；未列出的按原样透传。 */
const SOFTWARE_ALIASES: Readonly<Record<string, string>> = {
  'node': 'node',
  'nodejs': 'node',
}

/**
 * 把本机供给探测结果投影成派单能力档案。
 *
 * 不编造：`cpu_brand` 取不到真实型号时留空；GPU 数量由真实探测结果决定，
 * `vram_mb` 只在探测到显存时给出，否则为 0。
 * @param probe - 本地供给探测结果（`probeLocalSupply` 的返回值）。
 * @param options - 可选覆盖：节点模式与档位由宿主策略决定，不由探测推断。
 * @returns 与上游 `we_workers.capabilities` 对齐的能力档案。
 */
export function projectNodeCapabilities(
  probe: SupplyProbeResult,
  options: {
    readonly mode?: string
    readonly tier?: string
    readonly llmModels?: readonly string[]
    readonly llmBackend?: string
    /**
     * 由能力声明管线（`capability-pipeline/pipeline.ts`）批准的能力广告。
     *
     * 给了它就**取代**按软件名推断出的广告面 —— 这是"没走管线就不出站"的接线点。
     * 为什么必须是取代而不是合并：`provided_capabilities` 是平台准入闸
     * （`services/capability_shadow.py:252` `hello_union_gate`）唯一读的东西，
     * 如果这里还保留"装了 ffmpeg 就自动多报 5 项"的推断路径，那么"主人三档确认"
     * 与"健康探测没过就不报"两条约束都可以被绕过。空数组是合法输入，表示"这次一项都不报"。
     *
     * 只保留注册表里的语义能力名（`mergeProvidedCapabilityAds`）是**纵深防御**，
     * 不是可见性出口：名字合不合法由管线第 ④ 步负责点名（旧式裸名、拼错的契约名、
     * 平台字段名各有各的告警），不要用这里的过滤当"没人知道它被丢了"的理由。
     */
    readonly providedCapabilities?: readonly ProvidedCapabilityAd[]
  } = {},
): NodeCapabilityProfile {
  const { hardware, localServices } = probe
  const verified = localServices.filter(service => service.verification === 'verified')
  const toolIds = verified.filter(service => service.kind === 'tool').map(service => service.id)
  const packageIds = verified.filter(service => service.kind === 'package').map(service => service.id)
  const modelIds = verified.filter(service => service.kind === 'local-model').map(service => service.id)
  // 注意：`modelIds` 来自 `verified`，待自检（pending）的模型不会进入广告面。
  /**
   * **挑出真正用来算的那块卡**，而不是盲取 `gpus[0]`。
   *
   * ## 为什么不能取第一个（真实故障）
   *
   * 原来这里是 `const gpu = hardware.gpus[0]`。在 Windows 上适配器枚举顺序会把
   * **远程串流工具的虚拟显示适配器**排在真卡之前——实测节点池里那台装了
   * RTX 5080 Laptop（16GB）的机器，**在线注册上报出去的却是**
   * `GameViewer Virtual Display Adapter`，`vram_mb` 也因此拿不到真值。
   *
   * 后果不是"少一个字段"，而是**调度侧无法把 GPU 任务匹配给这台机器**：
   * 计划器看到的是"一块虚拟显示器"，于是它的 5080 等于不存在。
   *
   * ## 判定规则
   *
   * 1. 先排除**虚拟/软件适配器**（远程串流、虚拟显示器、基础渲染驱动等）——
   *    它们不是可用来算的 GPU；
   * 2. 在剩余的**真实适配器**里取**显存最大**的那块作为主卡
   *    （多卡机器上报最强的一块，与 `vram_mb` 的单值语义一致）；
   * 3. 若一个真实适配器都没有（例如纯软件环境），**回退到原始列表**而不是上报"无卡"——
   *    宁可保守地把实际情况报上去，也不假装机器没有 GPU。
   */
  const realGpus = hardware.gpus.filter(adapter => !VIRTUAL_ADAPTER_PATTERN.test(adapter.name))
  const gpuPool = realGpus.length > 0 ? realGpus : hardware.gpus
  const gpu = [...gpuPool].sort((left, right) => (right.memoryBytes ?? 0) - (left.memoryBytes ?? 0))[0]
  const totalMemory = hardware.totalMemoryBytes > 0 ? hardware.totalMemoryBytes : totalmem()
  const runtimes = [...new Set(toolIds.map(id => SOFTWARE_ALIASES[id] ?? id))]
  const software = [...new Set([...runtimes, ...packageIds])]
  const nativeBinaries = [...new Set(toolIds)]
  const advertised = advertisedNamesFromProbe(probe)

  return {
    os: OS_SHORT_NAME[hardware.platform] ?? hardware.platform,
    arch: ARCH_NAME[hardware.arch] ?? hardware.arch,
    mode: options.mode ?? 'paused',
    tier: options.tier ?? 'basic',
    os_name: platform(),
    os_version: release(),
    hostname: hostname(),
    device_name: hostname(),
    cpu_brand: hardware.cpuModel === 'unknown' ? '' : hardware.cpuModel,
    cpu_cores: hardware.logicalCores,
    cpu_threads: hardware.logicalCores,
    runtimes,
    software,
    native_binaries: nativeBinaries,
    provided_capabilities: options.providedCapabilities === undefined
      ? providedCapabilityAds(advertised)
      : mergeProvidedCapabilityAds(options.providedCapabilities),
    gpu_count: hardware.gpus.length,
    gpu_model: gpu ? `${gpu.name}${gpu.vendor ? ` (${gpu.vendor})` : ''}` : '',
    vram_mb: gpu?.memoryBytes ? Math.floor(gpu.memoryBytes / 1048576) : 0,
    // 只广告通过自检的本地模型：`pending` 的模型尚未证明能推理，广告出去等于承诺做不到的事。
    llm_models: [...(options.llmModels ?? modelIds)],
    llm_backend: options.llmBackend ?? '',
    uptime_sec: Math.floor(uptime()),
    memory_gb: Math.round((totalMemory / 1024 ** 3) * 10) / 10,
    total_memory_mb: Math.floor(totalMemory / 1048576),
    ...measuredDiskMb(),
  }
}

/**
 * Largest filesystem this host can name, in MB.
 *
 * Why it is measured here: the platform shows `total_disk_mb` / `free_disk_mb` on every worker row
 * (as 0 until a node reports them), and a node that reports nothing cannot be routed around when it
 * really is full. The measurement is a plain `statfs` of the host data directory — the same place
 * attempts are staged — and an unmeasurable value is omitted rather than reported as zero.
 * @returns The two reportable keys, or nothing when the filesystem cannot be measured.
 */
function measuredDiskMb(): { total_disk_mb: number; free_disk_mb: number } | Record<string, never> {
  const candidates = [process.env.DSH_HOME, join(homedir(), 'qianshou'), homedir()]
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') continue
    try {
      const stats = statfsSync(candidate)
      const total = stats.blocks * stats.bsize
      const free = stats.bavail * stats.bsize
      if (!Number.isSafeInteger(total) || !Number.isSafeInteger(free) || total <= 0 || free < 0) continue
      return { total_disk_mb: Math.floor(total / 1048576), free_disk_mb: Math.floor(free / 1048576) }
    } catch { /* try the next candidate; an unmeasurable disk stays unreported */ }
  }
  return {}
}

/** 节点自报的 `arch` 是否与本机一致；不一致说明拿错了别的机器的档案。 */
export function capabilityArchMatchesLocal(profile: NodeCapabilityProfile): boolean {
  return profile.arch === (ARCH_NAME[arch()] ?? arch())
}
