/**
 * 工单 8 · 第 ③ 步：健康探测真实化 —— "装了"≠"能用"。
 *
 * ## 这个测试防的是什么
 *
 * 实测事故：**假健康**。本机 `local-probe.ts` 的判定是"命令能跑出版本号就算 `verified`"，
 * 但"文件在 / 命令在 PATH 里 / 版本号能打出来"与"这个能力真能干活"是两件事
 * （模型能加载吗？显存够吗？插件绑定还在吗？）。
 *
 * 所以本模块的契约是：**`invoked: true` 是 `ok` 的必要条件**。一个只报告"文件存在"的探测端口
 * 必须被判为 `missing`，并且给出可解释的原因；失败项**不得进入候选池**。
 */
import { describe, expect, it } from 'vitest'
import {
  candidateCapabilities,
  healthRefusals,
  probeCapabilityHealth,
  type CapabilityProbeOutcome,
  type CapabilityProbePort,
} from '../../src/capability-pipeline/health-probe.ts'

/** 记录每次调用的端口：探测真实性的证据是"真的调用过"，不是"返回了 ok"。 */
function recordingPort(outcomes: Readonly<Record<string, CapabilityProbeOutcome>>): CapabilityProbePort & { readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    invoke: async (capability: string): Promise<CapabilityProbeOutcome> => {
      calls.push(capability)
      const outcome = outcomes[capability]
      if (outcome === undefined) throw new Error(`no fixture outcome for ${capability}`)
      return outcome
    },
  }
}

describe('③ 假健康：只有"文件在"不构成健康证据', () => {
  it('端口说 ok 但 invoked=false（只检查了文件存在）⇒ health=missing，原因 PROBE_NOT_AN_INVOCATION', async () => {
    const port = recordingPort({
      'media.transcode': { invoked: false, ok: true, detail: 'PATH 里有 ffmpeg，版本号可读' },
    })
    const [observation] = await probeCapabilityHealth(['media.transcode'], port)
    expect(observation).toEqual({
      capability: 'media.transcode',
      health: 'missing',
      invoked: false,
      reason: 'PROBE_NOT_AN_INVOCATION',
      detail: expect.stringContaining('ffmpeg'),
    })
    expect(candidateCapabilities([observation!])).toEqual([])
  })

  it('最小真实调用失败 ⇒ health=missing，原因就是执行器的真实失败原因', async () => {
    const port = recordingPort({
      'media.transcode': { invoked: true, ok: false, reason: 'EXECUTOR_EXIT_NONZERO', detail: 'ffmpeg -f null - 退出码 1' },
    })
    const [observation] = await probeCapabilityHealth(['media.transcode'], port)
    expect(observation?.health).toBe('missing')
    expect(observation?.invoked).toBe(true)
    expect(observation?.reason).toBe('EXECUTOR_EXIT_NONZERO')
    expect(healthRefusals([observation!])).toEqual([
      { capability: 'media.transcode', reason: 'EXECUTOR_EXIT_NONZERO', detail: 'ffmpeg -f null - 退出码 1' },
    ])
  })

  it('真跑一遍且成功 ⇒ health=ok，缺原因时不给假原因', async () => {
    const port = recordingPort({ 'text.transform': { invoked: true, ok: true } })
    const [observation] = await probeCapabilityHealth(['text.transform'], port)
    expect(observation).toEqual({
      capability: 'text.transform',
      health: 'ok',
      invoked: true,
      reason: null,
      detail: expect.any(String),
    })
    expect(candidateCapabilities([observation!])).toEqual(['text.transform'])
  })

  it('降级（能跑但结果打折）也不进候选池：只放行 health=ok', async () => {
    const port = recordingPort({
      'llm.generate.local': { invoked: true, ok: true, degraded: true, detail: '模型能加载但 4bit 量化' },
    })
    const [observation] = await probeCapabilityHealth(['llm.generate.local'], port)
    expect(observation?.health).toBe('degraded')
    expect(candidateCapabilities([observation!])).toEqual([])
    expect(healthRefusals([observation!])).toEqual([
      { capability: 'llm.generate.local', reason: 'PROBE_REPORTED_DEGRADED', detail: '模型能加载但 4bit 量化' },
    ])
  })

  it('探测端口抛错 ⇒ 记成 missing（不是"没探测到"就当作不存在原因的 ok）', async () => {
    const port: CapabilityProbePort = {
      invoke: async () => { throw new Error('spawn EACCES') },
    }
    const [observation] = await probeCapabilityHealth(['render.3d'], port)
    expect(observation?.health).toBe('missing')
    expect(observation?.reason).toBe('PROBE_THREW')
    expect(observation?.detail).toContain('spawn EACCES')
  })

  it('探测端口返回 ok 却没给失败原因码 ⇒ 仍然放行，但 detail 不许为空（主人要能读懂）', async () => {
    const port = recordingPort({ 'compute.numeric': { invoked: true, ok: true } })
    const [observation] = await probeCapabilityHealth(['compute.numeric'], port)
    expect(observation?.health).toBe('ok')
    expect(observation?.detail.length).toBeGreaterThan(0)
  })
})

describe('③ 每一项能力都要被真的调用一次，且结果按能力名稳定排序', () => {
  it('候选池是按能力逐项探测的结果，不是整机一个健康位', async () => {
    const port = recordingPort({
      'media.transcode': { invoked: true, ok: true, detail: '最小转码通过' },
      'media.probe': { invoked: true, ok: false, reason: 'EXECUTOR_TIMEOUT', detail: 'ffprobe 超时' },
      'compute.numeric': { invoked: true, ok: true, detail: 'numpy 矩阵乘通过' },
    })
    const observations = await probeCapabilityHealth(['media.transcode', 'compute.numeric', 'media.probe'], port)
    expect(port.calls.sort()).toEqual(['compute.numeric', 'media.probe', 'media.transcode'])
    expect(candidateCapabilities(observations)).toEqual(['compute.numeric', 'media.transcode'])
    expect(healthRefusals(observations).map(refusal => refusal.capability)).toEqual(['media.probe'])
  })

  it('同一能力重复出现只探测一次（探测有真实代价，不许重复跑）', async () => {
    const port = recordingPort({ 'media.transcode': { invoked: true, ok: true, detail: 'ok' } })
    await probeCapabilityHealth(['media.transcode', 'media.transcode'], port)
    expect(port.calls).toEqual(['media.transcode'])
  })

  it('空候选集是合法结果：没有任何能力被证明可用时，广告面就是空的', async () => {
    const port = recordingPort({})
    await expect(probeCapabilityHealth([], port)).resolves.toEqual([])
  })
})
