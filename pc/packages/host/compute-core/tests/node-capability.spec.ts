/**
 * 派单能力投影的契约测试。
 *
 * 这些断言锁的是**上游字段名**：`platform_v8/protocol/ws_schema.py:42` 的
 * `HelloPayload.capabilities` 会被 `services/workers/register` 原样落库为节点档案，
 * 派单侧按 `runtimes` / `software` / `gpu_count` 等字段判资格。字段名改错不会报错，
 * 只会让节点在派单视角里"不合格"——2026-09-15 的真实故障正是如此。
 */
import { describe, expect, it } from 'vitest'
import { mergeProvidedCapabilityAds, projectNodeCapabilities, providedCapabilityAdsForIds } from '../src/node-capability.ts'
import { CAPABILITY_REGISTRY_VERSION } from '../src/capability-registry.ts'
import type { SupplyProbeResult } from '../src/supply/types.ts'

/** 一台有 python3/ffmpeg、带 Apple GPU 的机器。 */
const documentedProbe: SupplyProbeResult = {
  hardware: {
    platform: 'darwin',
    arch: 'arm64',
    cpuModel: 'Apple M4',
    logicalCores: 10,
    totalMemoryBytes: 17_179_869_184,
    freeMemoryBytes: 2_000_000_000,
    gpus: [{ name: 'Apple M4', vendor: 'sppci_vendor_Apple', memoryBytes: null }],
    probeErrors: [],
  },
  localServices: [
    { id: 'python3', kind: 'tool', name: 'Python', version: '3.12.0', verification: 'verified', reason: null },
    { id: 'ffmpeg', kind: 'tool', name: 'ffmpeg', version: '6.0', verification: 'verified', reason: null },
    { id: 'git', kind: 'tool', name: 'git', version: '2.5', verification: 'verified', reason: null },
    { id: 'moondream', kind: 'local-model', name: 'moondream', version: null, verification: 'pending', reason: 'SELF_TEST_PENDING' },
  ],
  activity: { idleSeconds: 12, foregroundTaskActive: false, voiceActive: false },
}

describe('派单能力投影', () => {
  it('把 Node 的 platform/arch 换成上游契约的短名', () => {
    const profile = projectNodeCapabilities(documentedProbe)
    expect(profile.os).toBe('macos')
    expect(profile.arch).toBe('aarch64')
  })

  it('只把已验证的工具放进 runtimes 与 software', () => {
    const profile = projectNodeCapabilities(documentedProbe)
    expect(profile.runtimes).toEqual(['python3', 'ffmpeg', 'git'])
    expect(profile.software).toEqual(['python3', 'ffmpeg', 'git'])
    expect(profile.native_binaries).toEqual(['python3', 'ffmpeg', 'git'])
  })

  it('待自检的本地模型不进入 runtimes，也不进入 llm_models', () => {
    const profile = projectNodeCapabilities(documentedProbe)
    expect(profile.runtimes).not.toContain('moondream')
    // `pending` 的模型尚未自检通过；广告它等于承诺一个还没证明的推理能力。
    expect(profile.llm_models).toEqual([])
  })

  it('已通过自检的本地模型会进入 llm_models，但仍不进 runtimes', () => {
    const profile = projectNodeCapabilities({
      ...documentedProbe,
      localServices: documentedProbe.localServices.map(service =>
        service.kind === 'local-model' ? { ...service, verification: 'verified' as const, reason: null } : service),
    })
    expect(profile.llm_models).toEqual(['moondream'])
    expect(profile.runtimes).not.toContain('moondream')
  })

  it('没有显存的 GPU 上报 vram_mb 为 0，而不是编造一个数字', () => {
    const profile = projectNodeCapabilities(documentedProbe)
    expect(profile.gpu_count).toBe(1)
    expect(profile.vram_mb).toBe(0)
    expect(profile.gpu_model).toContain('Apple M4')
  })

  it('探测不到 CPU 型号时留空，不写占位符', () => {
    const profile = projectNodeCapabilities({
      ...documentedProbe,
      hardware: { ...documentedProbe.hardware, cpuModel: 'unknown' },
    })
    expect(profile.cpu_brand).toBe('')
  })

  it('模式默认 paused —— 未获授权前绝不宣称可运行', () => {
    expect(projectNodeCapabilities(documentedProbe).mode).toBe('paused')
  })

  it('宿主可以把模式与档位显式改成 running', () => {
    const profile = projectNodeCapabilities(documentedProbe, { mode: 'running', tier: 'pro' })
    expect(profile.mode).toBe('running')
    expect(profile.tier).toBe('pro')
  })

  it('内存同时给出上游用到的两种口径（memory_gb 与 total_memory_mb）', () => {
    const profile = projectNodeCapabilities(documentedProbe)
    expect(profile.memory_gb).toBe(16)
    expect(profile.total_memory_mb).toBe(16384)
  })

  it('空探测结果产生空能力，绝不推断出并不存在的运行时', () => {
    const profile = projectNodeCapabilities({
      hardware: {
        platform: 'linux', arch: 'x64', cpuModel: 'unknown', logicalCores: 0,
        totalMemoryBytes: 0, freeMemoryBytes: 0, gpus: [], probeErrors: ['TOOL_PROBE_UNAVAILABLE'],
      },
      localServices: [],
      activity: { idleSeconds: null, foregroundTaskActive: null, voiceActive: null },
    })
    expect(profile.runtimes).toEqual([])
    expect(profile.software).toEqual([])
    expect(profile.provided_capabilities).toEqual([])
    expect(profile.gpu_count).toBe(0)
    expect(profile.gpu_model).toBe('')
    expect(profile.os).toBe('linux')
    expect(profile.arch).toBe('x86_64')
  })

  it('同一工具重复上报只保留一份', () => {
    const profile = projectNodeCapabilities({
      ...documentedProbe,
      localServices: [
        ...documentedProbe.localServices,
        { id: 'python3', kind: 'tool', name: 'Python', version: '3.12.0', verification: 'verified', reason: null },
      ],
    })
    expect(profile.runtimes.filter(id => id === 'python3')).toHaveLength(1)
  })

  it('dual-writes registry capabilities for ffmpeg and does not claim whisper or OCR', () => {
    const profile = projectNodeCapabilities(documentedProbe)
    const names = profile.provided_capabilities.map(item => item.name)
    expect(names).toEqual([
      'audio.extract',
      'audio.transcode',
      'media.probe',
      'media.thumbnail',
      'media.transcode',
    ])
    expect(profile.provided_capabilities.every(item => item.health === 'ok' && item.version === CAPABILITY_REGISTRY_VERSION)).toBe(true)
    expect(names).not.toContain('speech.transcribe')
    expect(names).not.toContain('ocr.image')
    expect(profile.software).toEqual(['python3', 'ffmpeg', 'git'])
  })

  it('puts verified packages in software only, not native_binaries or runtimes', () => {
    const profile = projectNodeCapabilities({
      ...documentedProbe,
      localServices: [
        ...documentedProbe.localServices,
        { id: 'numpy', kind: 'package', name: 'NumPy', version: '2.4.3', verification: 'verified', reason: null },
      ],
    })
    expect(profile.software).toEqual(['python3', 'ffmpeg', 'git', 'numpy'])
    expect(profile.runtimes).toEqual(['python3', 'ffmpeg', 'git'])
    expect(profile.native_binaries).toEqual(['python3', 'ffmpeg', 'git'])
    expect(profile.provided_capabilities.map(item => item.name)).toContain('compute.numeric')
  })

  it('does not advertise web.fetch unless both roles are present', () => {
    const requestsOnly = projectNodeCapabilities({
      ...documentedProbe,
      localServices: [
        { id: 'requests', kind: 'tool', name: 'requests', version: '2.0', verification: 'verified', reason: null },
      ],
    })
    expect(requestsOnly.provided_capabilities.map(item => item.name)).not.toContain('web.fetch')
    const both = projectNodeCapabilities({
      ...documentedProbe,
      localServices: [
        { id: 'requests', kind: 'tool', name: 'requests', version: '2.0', verification: 'verified', reason: null },
        { id: 'selectolax', kind: 'tool', name: 'selectolax', version: '0.3', verification: 'verified', reason: null },
      ],
    })
    expect(both.provided_capabilities.map(item => item.name)).toContain('web.fetch')
  })

  it('keeps installed faster-whisper as inventory without promising transcription and does not treat pymupdf as OCR', () => {
    const hyphen = projectNodeCapabilities({
      ...documentedProbe,
      localServices: [
        { id: 'faster-whisper', kind: 'tool', name: 'faster-whisper', version: '1.0', verification: 'verified', reason: null },
      ],
    })
    expect(hyphen.provided_capabilities).toEqual([])
    expect(hyphen.software).toEqual(['faster-whisper'])
    const pdf = projectNodeCapabilities({
      ...documentedProbe,
      localServices: [
        { id: 'pymupdf', kind: 'tool', name: 'pymupdf', version: '1.24', verification: 'verified', reason: null },
      ],
    })
    expect(pdf.provided_capabilities.map(item => item.name)).toEqual(['doc.pdf.extract', 'doc.pdf.probe'])
    expect(pdf.provided_capabilities.map(item => item.name)).not.toContain('ocr.image')
  })

  it.each(['ollama', 'local_llm', 'moondream2', 'onnxruntime', 'faster_whisper'])(
    'does not advertise model inference from the verified %s package', (id) => {
      const profile = projectNodeCapabilities({
        ...documentedProbe,
        localServices: [{ id, kind: 'package', name: id, version: '1.0', verification: 'verified', reason: null }],
      })
      expect(profile.software).toEqual([id])
      expect(profile.provided_capabilities).toEqual([])
    },
  )

  it('builds and merges ads only for registry semantic ids', () => {
    expect(providedCapabilityAdsForIds(['text.transform', 'word_count', 'text.transform'])).toEqual([
      { name: 'text.transform', version: CAPABILITY_REGISTRY_VERSION, health: 'ok' },
    ])
    expect(providedCapabilityAdsForIds(['ocr_image'])).toEqual([])
    const probe = providedCapabilityAdsForIds([
      'audio.extract', 'audio.transcode', 'media.probe', 'media.thumbnail', 'media.transcode',
    ])
    const merged = mergeProvidedCapabilityAds(probe, providedCapabilityAdsForIds(['text.transform']))
    expect(merged.map(item => item.name)).toEqual([
      'audio.extract',
      'audio.transcode',
      'media.probe',
      'media.thumbnail',
      'media.transcode',
      'text.transform',
    ])
    expect(mergeProvidedCapabilityAds(
      providedCapabilityAdsForIds(['text.transform']),
      [{ name: 'word_count', version: CAPABILITY_REGISTRY_VERSION, health: 'ok' }],
    )).toEqual(providedCapabilityAdsForIds(['text.transform']))
  })
})
