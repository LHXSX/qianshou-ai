/**
 * A 工单：真实探测端口的判定规则。
 *
 * 这些用例**不跑任何真进程**（外部执行被 `spawn` 注入缝替换），
 * 钉的是"什么才算真的调用过、什么时候不许算通过"这条规则本身。
 * 真机验证另做：`createRealProbePort()` 默认实现会真的起 ffmpeg/ffprobe/… 并读版本行。
 */

import { describe, expect, it, vi } from 'vitest'

import { createRealProbePort, PROBE_FAILURE_REASONS } from '../../src/capability-pipeline/real-probe-port.ts'
import { candidateCapabilities, probeCapabilityHealth } from '../../src/capability-pipeline/health-probe.ts'

const FFMPEG_OK = { code: 0, stdout: 'ffmpeg version 8.0.1 Copyright (c) 2000-2025\n', stderr: '' }

describe('createRealProbePort · 判定规则', () => {
  it('进程真的起来且退出码 0、输出可识别 ⇒ ok 且 invoked=true', async () => {
    const spawn = vi.fn(async () => FFMPEG_OK)
    const outcome = await createRealProbePort({ spawn }).invoke('ffmpeg')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(outcome.invoked).toBe(true)
    expect(outcome.ok).toBe(true)
    expect(outcome.detail).toContain('ffmpeg version 8.0.1')
  })

  it('没有调用配方 ⇒ 明确拒绝：invoked=false 且给 NO_INVOCATION_RECIPE（绝不猜）', async () => {
    const spawn = vi.fn(async () => FFMPEG_OK)
    const outcome = await createRealProbePort({ spawn }).invoke('mystery.capability')
    // 关键：连进程都不该起 —— 不知道该怎么验，就不许假装验过
    expect(spawn).not.toHaveBeenCalled()
    expect(outcome.invoked).toBe(false)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe(PROBE_FAILURE_REASONS.NO_INVOCATION_RECIPE)
  })

  it('退出码非零 ⇒ invoked=true 但 ok=false，并带原因与可读细节', async () => {
    const spawn = vi.fn(async () => ({ code: 3, stdout: '', stderr: 'boom\n' }))
    const outcome = await createRealProbePort({ spawn }).invoke('ffmpeg')
    expect(outcome.invoked).toBe(true)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe(PROBE_FAILURE_REASONS.EXIT_NONZERO)
    expect(outcome.detail).toContain('退出码 3')
  })

  it('进程根本起不来（ENOENT）⇒ invoked=true（试过了）但 ok=false 且归 SPAWN_FAILED', async () => {
    const spawn = vi.fn(async () => ({ code: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }) }))
    const outcome = await createRealProbePort({ spawn }).invoke('ffmpeg')
    expect(outcome.invoked).toBe(true)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe(PROBE_FAILURE_REASONS.SPAWN_FAILED)
  })

  it('spawn 直接抛错 ⇒ 记成失败而不是让探测把节点带崩', async () => {
    const spawn = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { code: 'EACCES' })
    })
    const outcome = await createRealProbePort({ spawn }).invoke('ffmpeg')
    expect(outcome.invoked).toBe(true)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe(PROBE_FAILURE_REASONS.SPAWN_FAILED)
  })

  it('能跑但输出不可识别 ⇒ degraded 且 ok=false（"文件在/能跑"不等于"能干活"）', async () => {
    const spawn = vi.fn(async () => ({ code: 0, stdout: 'something else entirely\n', stderr: '' }))
    const outcome = await createRealProbePort({ spawn }).invoke('ffmpeg')
    expect(outcome.invoked).toBe(true)
    expect(outcome.ok).toBe(false)
    expect(outcome.degraded).toBe(true)
  })

  it('探测前已被中止 ⇒ 不起进程且归 ABORTED', async () => {
    const spawn = vi.fn(async () => FFMPEG_OK)
    const controller = new AbortController()
    controller.abort()
    const outcome = await createRealProbePort({ spawn }).invoke('ffmpeg', controller.signal)
    expect(spawn).not.toHaveBeenCalled()
    expect(outcome.invoked).toBe(false)
    expect(outcome.reason).toBe(PROBE_FAILURE_REASONS.ABORTED)
  })

  it('可注入自定义配方（新增一项能力 = 加一条配方，不是放宽判定）', async () => {
    const spawn = vi.fn(async () => ({ code: 0, stdout: 'my-tool 1.2.3\n', stderr: '' }))
    const port = createRealProbePort({
      spawn,
      recipes: { 'my.tool': { command: 'my-tool', args: ['--version'], recognizes: line => /^my-tool /.test(line) } },
    })
    const outcome = await port.invoke('my.tool')
    expect(outcome.ok).toBe(true)
    expect(spawn).toHaveBeenCalledWith('my-tool', ['--version'], expect.objectContaining({ timeoutMs: 5_000 }))
  })
})

describe('createRealProbePort → 管线：只有 ok 才进候选池', () => {
  it('degraded 与"没有配方"都不进候选池，且能说清为什么', async () => {
    const spawn = vi.fn(async (command: string) =>
      command === 'ffmpeg' ? { code: 0, stdout: 'ffmpeg version 8.0.1\n', stderr: '' } : { code: 0, stdout: 'unrecognized\n', stderr: '' },
    )
    const port = createRealProbePort({ spawn })
    const observations = await probeCapabilityHealth(['ffmpeg', 'git', 'mystery.capability'], port)
    expect(candidateCapabilities(observations)).toEqual(['ffmpeg'])
    const refused = observations.filter(o => o.health !== 'ok').map(o => o.capability)
    expect(refused.sort()).toEqual(['git', 'mystery.capability'])
  })
})
