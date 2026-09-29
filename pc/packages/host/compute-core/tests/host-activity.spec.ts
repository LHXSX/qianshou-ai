import { describe, expect, it, vi } from 'vitest'
import {
  createHostIdleReader,
  HOST_IDLE_THRESHOLD_SECONDS,
  idleCommandFor,
} from '../src/host-activity.ts'

/**
 * AT-10 的回归面：`allowWhileUserActive` 以前判在两个常量 `false` 上，策略分支永不可达。
 * 这里钉住真实读数的三条硬判据——**测到了就如实判**、**测不到就是"未知"而不是 false**、
 * **同一秒内不重复起子进程**——以及两个平台的解析与失败路径。
 */
describe('host activity readings', () => {
  it('reads macOS HIDIdleTime in nanoseconds and judges activity against the threshold', async () => {
    const run = vi.fn(async (_command: string, _args: readonly string[]) => '    "HIDIdleTime" = 5000000000\n')
    const reader = createHostIdleReader({ platform: 'darwin', run, clock: () => 1_000 })
    await expect(reader.read()).resolves.toEqual({ userActive: true, idleSeconds: 5, unavailable: null })
    expect(run.mock.calls[0]?.[0]).toBe('/usr/sbin/ioreg')

    const away = createHostIdleReader({ platform: 'darwin', run: async () => '"HIDIdleTime" = 600000000000\n', clock: () => 0 })
    await expect(away.read()).resolves.toEqual({ userActive: false, idleSeconds: 600, unavailable: null })
    expect(HOST_IDLE_THRESHOLD_SECONDS).toBe(60)
  })

  it('reads Windows GetLastInputInfo in milliseconds through PowerShell', async () => {
    const run = vi.fn(async (_command: string, _args: readonly string[]) => '1500\n')
    const reader = createHostIdleReader({ platform: 'win32', run, clock: () => 0 })
    await expect(reader.read()).resolves.toEqual({ userActive: true, idleSeconds: 1, unavailable: null })
    const call = run.mock.calls[0]
    expect(call?.[0]).toBe('powershell.exe')
    expect(call?.[1].join(' ')).toContain('GetLastInputInfo')
    // 无交互、无 profile 解析：不给它加载用户配置或卡在交互提示上的机会。
    expect(call?.[1]).toContain('-NoProfile')
  })

  it.each([
    ['linux', 'IDLE_PROBE_UNSUPPORTED'],
  ])('reports an explicit unknown on %s instead of claiming an idle machine', async (platform, code) => {
    const run = vi.fn(async (_command: string, _args: readonly string[]) => '0\n')
    const reader = createHostIdleReader({ platform, run, clock: () => 0 })
    await expect(reader.read()).resolves.toEqual({ userActive: null, idleSeconds: null, unavailable: code })
    expect(run).not.toHaveBeenCalled()
    expect(idleCommandFor(platform)).toBeNull()
  })

  it('turns a failed or unparsable command into an unknown, never into false', async () => {
    const failed = createHostIdleReader({ platform: 'darwin', run: async () => { throw new Error('ioreg missing') }, clock: () => 0 })
    await expect(failed.read()).resolves.toEqual({ userActive: null, idleSeconds: null, unavailable: 'IDLE_PROBE_FAILED' })
    const garbage = createHostIdleReader({ platform: 'darwin', run: async () => 'no HIDIdleTime here', clock: () => 0 })
    await expect(garbage.read()).resolves.toEqual({ userActive: null, idleSeconds: null, unavailable: 'IDLE_PROBE_FAILED' })
    const badWindows = createHostIdleReader({ platform: 'win32', run: async () => 'not-a-number\n', clock: () => 0 })
    await expect(badWindows.read()).resolves.toEqual({ userActive: null, idleSeconds: null, unavailable: 'IDLE_PROBE_FAILED' })
  })

  it.each(['', ' ', '\r\n', '-1', '1.5', '1e3', 'Infinity', '4294967296', '5\nwarning'])('rejects invalid Windows idle output %j', async (stdout) => {
    const reader = createHostIdleReader({ platform: 'win32', run: async () => stdout })
    await expect(reader.read()).resolves.toEqual({ userActive: null, idleSeconds: null, unavailable: 'IDLE_PROBE_FAILED' })
  })

  it('rejects overflowing macOS readings instead of declaring the machine idle', async () => {
    const reader = createHostIdleReader({ platform: 'darwin', run: async () => `"HIDIdleTime" = ${'9'.repeat(320)}` })
    await expect(reader.read()).resolves.toMatchObject({ userActive: null, unavailable: 'IDLE_PROBE_FAILED' })
  })

  it.runIf(process.platform === 'win32')('executes the Windows native idle probe', async () => {
    // Execute the shipping script; mocked stdout cannot detect PowerShell syntax or P/Invoke errors.
    const reading = await createHostIdleReader({ timeoutMs: 15_000, cacheMs: 0 }).read()
    expect(reading.unavailable).toBeNull()
    expect(reading.idleSeconds).toEqual(expect.any(Number))
    expect(reading.userActive).toEqual(expect.any(Boolean))
  }, 20_000)

  it('caches one measurement for the freshness window so a 1Hz tick does not fork 1Hz', async () => {
    let now = 0
    const run = vi.fn(async (_command: string, _args: readonly string[]) => '"HIDIdleTime" = 1000000000\n')
    const reader = createHostIdleReader({ platform: 'darwin', run, clock: () => now })
    await reader.read()
    now += 4_000
    await reader.read()
    expect(run).toHaveBeenCalledTimes(1)
    // 读数天然过期后必须重新测，而不是永远复用第一次的结论。
    now += 5_000
    await expect(reader.read()).resolves.toMatchObject({ idleSeconds: 1 })
    expect(run).toHaveBeenCalledTimes(2)
  })
})
