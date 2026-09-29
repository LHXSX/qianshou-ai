/**
 * The capability-advertisement contract: what this client sends must survive the dispatcher's
 * whitelist.
 *
 * ## The failure this test exists for
 *
 * The platform's `_worker_capabilities` (`storage/repo.py:1811-1814`) keeps only the keys its
 * `WorkerCapabilities` dataclass declares:
 *
 * ```python
 * def _worker_capabilities(**kwargs: Any) -> WorkerCapabilities:
 *     """只传当前 WorkerCapabilities 已声明字段，避免客户端多报键把整条注册打崩。"""
 *     allowed = {f.name for f in dc_fields(WorkerCapabilities)}
 *     return WorkerCapabilities(**{k: v for k, v in kwargs.items() if k in allowed})
 * ```
 *
 * Unknown keys are dropped **silently** — no error, no log, and registration still succeeds. So a
 * misspelled field name does not fail anything: it quietly deletes a capability block while every
 * existing test stays green, and the node looks "connected and healthy" with a truncated profile.
 * `native_bins` versus `native_binaries` lived that way for two months.
 *
 * ## Why one assertion covers three separate divergences
 *
 * 1. **A key the platform does not declare** (`native_bins`, `uptime_sec`) — caught directly.
 * 2. **The correct name of the field that replaced it** (`native_binaries`) — the test fails if the
 *    client stops sending a key the platform does declare, so the fix cannot silently regress.
 * 3. **A right key carrying a wrong value** (`os: 'win32'` instead of `'windows'`) — caught by the
 *    value assertions, which no key-name check could ever see.
 *
 * The fixture's provenance and its one known limitation (it cannot prove the dataclass is
 * *complete*, only that a published key is *declared*) are documented at length in
 * `tests/fixtures/platform-worker-capabilities.ts`. Read that header before editing either file.
 */
import { describe, expect, it } from 'vitest'
import { projectNodeCapabilities } from '../src/node-capability.ts'
import { HOST_SUPPLY_TOOLS } from '../src/index.ts'
import type { SupplyProbeResult } from '../src/supply/types.ts'
import {
  PLATFORM_ARCH_NAMES,
  PLATFORM_CAPABILITY_FIXTURE_RECORDED_AT,
  PLATFORM_CAPABILITY_FIXTURE_SOURCE,
  PLATFORM_OS_NAMES,
  PLATFORM_WORKER_CAPABILITY_KEYS,
} from './fixtures/platform-worker-capabilities.ts'

/** One machine with a real GPU and two verified tools. */
const probe: SupplyProbeResult = {
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
  ],
  activity: { idleSeconds: 12, foregroundTaskActive: false, voiceActive: false },
}

const platformKeys = new Set(PLATFORM_WORKER_CAPABILITY_KEYS)

/**
 * Keys this client puts in `hello.capabilities` that the platform's whitelist drops.
 *
 * **These are known, scoped divergences, not oversights.** They are listed here so the subset check
 * still fails on *any third* key while being explicit about the two it tolerates:
 *
 * - `mode` — the local supply mode the owner authorized (`edge-binding.ts:140` passes `supply()`).
 *   The platform's stored field for this concept is `contribute_mode`, and it never persists `mode`
 *   from hello. It stays in the payload because it is the node's own posture statement on the
 *   registration frame, and `node-capability.spec.ts` pins its default as a safety property
 *   ("未获授权前绝不宣称可运行"). Moving or renaming it is a separate, owner-visible decision.
 * - `uptime_sec` — no consumer on either side. The platform reads it only from the **heartbeat**
 *   channel (`services/workers/heartbeat.py:135-139`), so a hello-time value is dead weight
 *   (audit §1.9).
 *
 * Removing either one changes advertised behaviour beyond the divergence this task was asked to
 * fix, so both are recorded rather than deleted, and the assertion below fails if a third appears.
 */
const KNOWN_CLIENT_ONLY_KEYS: readonly string[] = Object.freeze(['mode', 'uptime_sec'])

describe('能力声明契约：hello capabilities ⊆ 平台 WorkerCapabilities', () => {
  it('夹具自身是一份可复核的观测，而不是凭记忆抄的清单', () => {
    // A duplicated name in the fixture would make the subset check quietly weaker.
    expect(platformKeys.size).toBe(PLATFORM_WORKER_CAPABILITY_KEYS.length)
    expect(PLATFORM_WORKER_CAPABILITY_KEYS).toEqual([...PLATFORM_WORKER_CAPABILITY_KEYS].sort())
    expect(PLATFORM_CAPABILITY_FIXTURE_SOURCE).toContain('AT-08.json')
    expect(PLATFORM_CAPABILITY_FIXTURE_RECORDED_AT).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('投影出来的每一个键都是平台声明过的字段（多一个键就会被静默丢弃）', () => {
    const profile = projectNodeCapabilities(probe)
    const undeclared = Object.keys(profile).filter(key => !platformKeys.has(key))
    expect(
      undeclared.sort(),
      `平台会静默丢弃这些键：${undeclared.join(', ')}（新增的有意为之的键必须先登记在 KNOWN_CLIENT_ONLY_KEYS 里）`,
    ).toEqual([...KNOWN_CLIENT_ONLY_KEYS].sort())
  })

  it('已知的两个客户端专属键始终只有这两个，多出第三个就失败', () => {
    // Guards the allow-list itself: without this, appending a new name to
    // KNOWN_CLIENT_ONLY_KEYS would be enough to make the contract check pass again.
    const profile = projectNodeCapabilities(probe)
    for (const key of KNOWN_CLIENT_ONLY_KEYS) expect(Object.keys(profile)).toContain(key)
    expect(KNOWN_CLIENT_ONLY_KEYS).toHaveLength(2)
  })

  it('平台确实读取的 native_binaries 正在被发出（native_bins 不是它的名字）', () => {
    const profile = projectNodeCapabilities(probe)
    expect(Object.keys(profile)).toContain('native_binaries')
    expect(Object.keys(profile)).not.toContain('native_bins')
    expect(profile.native_binaries).toEqual(['python3', 'ffmpeg'])
  })

  it('os 与 arch 用平台短名，不泄漏 Node 的名字（win32 不在契约里）', () => {
    const darwin = projectNodeCapabilities(probe)
    expect(PLATFORM_OS_NAMES).toContain(darwin.os)
    expect(PLATFORM_ARCH_NAMES).toContain(darwin.arch)

    // The mapping's real risk is the Windows branch, which no POSIX run reaches. Feeding the
    // Node platform name straight in exercises `OS_SHORT_NAME` rather than the host's own value.
    for (const [nodePlatform, expected] of [['win32', 'windows'], ['darwin', 'macos'], ['linux', 'linux']] as const) {
      const profile = projectNodeCapabilities({ ...probe, hardware: { ...probe.hardware, platform: nodePlatform } })
      expect(profile.os, `${nodePlatform} 必须映射成平台短名`).toBe(expected)
      expect(PLATFORM_OS_NAMES).toContain(profile.os)
    }
  })

  it('平台真正读的字段名与客户端发的那两个名字不同：contribute_mode / native_binaries', () => {
    // `mode` and `uptime_sec` are the tolerated extras documented above; the platform's own names
    // for the concepts behind them are `contribute_mode` and (heartbeat-only) `uptime_sec`. Asserting
    // the platform names are present in the fixture keeps the allow-list honest: it stays a record of
    // a real mismatch rather than a place to hide arbitrary keys.
    expect(platformKeys.has('contribute_mode')).toBe(true)
    expect(platformKeys.has('native_binaries')).toBe(true)
    expect(platformKeys.has('mode')).toBe(false)
  })
})

/**
 * The one catalogue every reader of "which tools does this machine have" must share.
 *
 * `HOST_SUPPLY_TOOLS` is what `apps/qianshou-node/node-daemon.mts` probes and what the supply page
 * renders. It used to exist three times; the node's copy had lost `ffprobe` and gained a `bash`
 * that nothing requires, and `projectNodeCapabilities` reports this list into the platform's
 * `software` field — which the planner hard-filters on. These assertions pin the single source so a
 * third copy cannot reappear unnoticed: a hand-written list diverging by one name fails here.
 */
describe('工具清单唯一来源：HOST_SUPPLY_TOOLS', () => {
  it('五个工具齐全，含 ffprobe，且不含无处可寻的 bash', () => {
    const ids = HOST_SUPPLY_TOOLS.map(tool => tool.id)
    expect(ids).toEqual(['node', 'git', 'python3', 'ffmpeg', 'ffprobe'])
    expect(ids).not.toContain('bash')
  })

  it('每个条目都带可执行命令与版本探测参数，不会上报一个无法验证的名字', () => {
    for (const tool of HOST_SUPPLY_TOOLS) {
      expect(tool.command.length).toBeGreaterThan(0)
      expect(tool.args.length).toBeGreaterThan(0)
    }
  })

  it('清单进入投影后的 software：这条链就是平台硬过滤读的那一条', () => {
    const profile = projectNodeCapabilities({
      hardware: probe.hardware,
      localServices: HOST_SUPPLY_TOOLS.map(tool => ({
        id: tool.id, kind: 'tool' as const, name: tool.name, version: '1.0', verification: 'verified' as const, reason: null,
      })),
      activity: { idleSeconds: null, foregroundTaskActive: null, voiceActive: null },
    })
    expect(profile.software).toEqual(['node', 'git', 'python3', 'ffmpeg', 'ffprobe'])
    expect(profile.native_binaries).toEqual(['node', 'git', 'python3', 'ffmpeg', 'ffprobe'])
    expect(profile.provided_capabilities.map(item => item.name)).toEqual([
      'audio.extract',
      'audio.transcode',
      'media.probe',
      'media.thumbnail',
      'media.transcode',
    ])
  })
})
