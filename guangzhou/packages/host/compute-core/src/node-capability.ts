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
 *   "native_bins": ["curl", "ffmpeg", "tesseract", …],
 *   "gpu_count": 1, "gpu_model": "Apple Silicon (Metal + MLX)", "vram_mb": 12288,
 *   "llm_models": [], "llm_backend": "llama_cpp", "uptime_sec": 2178910,
 *   "memory_gb": 16.0, "total_memory_mb": 16384 }
 * ```
 *
 * 本模块只做**忠实的字段映射**：探测不到的事实一律留空或省略，绝不编造。
 */
import { hostname, platform, arch, release, totalmem, uptime } from 'node:os'
import type { SupplyProbeResult } from './supply/types.ts'

/** 一个节点上报给调度中心的能力档案；字段名与上游 `we_workers.capabilities` 对齐。 */
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
  readonly native_bins: readonly string[]
  readonly gpu_count: number
  readonly gpu_model: string
  readonly vram_mb: number
  readonly llm_models: readonly string[]
  readonly llm_backend: string
  readonly uptime_sec: number
  readonly memory_gb: number
  readonly total_memory_mb: number
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
  options: { readonly mode?: string; readonly tier?: string; readonly llmModels?: readonly string[]; readonly llmBackend?: string } = {},
): NodeCapabilityProfile {
  const { hardware, localServices } = probe
  const verified = localServices.filter(service => service.verification === 'verified')
  const toolIds = verified.filter(service => service.kind === 'tool').map(service => service.id)
  const modelIds = verified.filter(service => service.kind === 'local-model').map(service => service.id)
  // 注意：`modelIds` 来自 `verified`，待自检（pending）的模型不会进入广告面。
  const gpu = hardware.gpus[0]
  const totalMemory = hardware.totalMemoryBytes > 0 ? hardware.totalMemoryBytes : totalmem()

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
    runtimes: [...new Set(toolIds.map(id => SOFTWARE_ALIASES[id] ?? id))],
    software: [...new Set(toolIds.map(id => SOFTWARE_ALIASES[id] ?? id))],
    native_bins: [...new Set(toolIds)],
    gpu_count: hardware.gpus.length,
    gpu_model: gpu ? `${gpu.name}${gpu.vendor ? ` (${gpu.vendor})` : ''}` : '',
    vram_mb: gpu?.memoryBytes ? Math.floor(gpu.memoryBytes / 1048576) : 0,
    // 只广告通过自检的本地模型：`pending` 的模型尚未证明能推理，广告出去等于承诺做不到的事。
    llm_models: [...(options.llmModels ?? modelIds)],
    llm_backend: options.llmBackend ?? '',
    uptime_sec: Math.floor(uptime()),
    memory_gb: Math.round((totalMemory / 1024 ** 3) * 10) / 10,
    total_memory_mb: Math.floor(totalMemory / 1048576),
  }
}

/** 节点自报的 `arch` 是否与本机一致；不一致说明拿错了别的机器的档案。 */
export function capabilityArchMatchesLocal(profile: NodeCapabilityProfile): boolean {
  return profile.arch === (ARCH_NAME[arch()] ?? arch())
}
