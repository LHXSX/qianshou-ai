/** 节点开关：启动/停止/幂等/令牌不上命令行（不真起进程，spawn 与 kill 都注入）。 */
import { describe, expect, it, vi } from 'vitest'
import { createNodeSwitch, NODE_SWITCH_CODES, type NodeSwitchConfig } from '../src/relay/node-switch.ts'

const alive = () => true
const base = { isAlive: alive, repoPath: '/repo', coreUrl: 'https://qianshousuanli.com', ownerId: 167, statusPort: 47625, token: 'TOKEN-abc' }

describe('createNodeSwitch', () => {
  it('启动：令牌只进环境变量，绝不进 argv', () => {
    const spawn = vi.fn<NodeSwitchConfig['spawn']>(() => 4242)
    const sw = createNodeSwitch({ ...base, spawn, kill: vi.fn() })
    expect(sw.start().pid).toBe(4242)
    const [cmd, args, options] = spawn.mock.calls[0]!
    expect(cmd).toBe('node_modules/.bin/tsx')
    expect(args.join(' ')).not.toContain('TOKEN-abc')       // ← 关键：argv 里不许有令牌
    expect(options.env.QIANSHOU_NODE_TOKEN).toBe('TOKEN-abc') // ← 只能在这里
  })

  it('默认 paused：上线待命，不自动接单', () => {
    const spawn = vi.fn<NodeSwitchConfig['spawn']>(() => 4242)
    const sw = createNodeSwitch({ ...base, spawn, kill: vi.fn() })
    sw.start()
    const args = spawn.mock.calls[0]![1]
    expect(args[args.indexOf('--mode') + 1]).toBe('paused')
  })

  it('幂等：已启动时再按启动，不重复起第二个（同机多节点会互相顶掉 workerId）', () => {
    const spawn = vi.fn(() => 4242)
    const sw = createNodeSwitch({ ...base, spawn, kill: vi.fn() })
    sw.start(); sw.start()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('停止：向本开关管的 pid 发 SIGTERM', () => {
    const kill = vi.fn()
    const sw = createNodeSwitch({ ...base, spawn: vi.fn(() => 4242), kill })
    sw.start()
    expect(sw.stop()).toMatchObject({ stopped: true })
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM')
  })

  it('没在管 ⇒ 如实报 NOT_MANAGED，绝不假装能停', () => {
    const sw = createNodeSwitch({ ...base, spawn: vi.fn(() => 1), kill: vi.fn() })
    expect(sw.stop()).toMatchObject({ stopped: false, code: NODE_SWITCH_CODES.NOT_MANAGED })
  })

  it('令牌若混进 argv ⇒ 直接拒绝启动（把踩过的坑钉住）', () => {
    const sw = createNodeSwitch({ ...base, token: 'paused', spawn: vi.fn(() => 1), kill: vi.fn() })
    expect(() => sw.start()).toThrowError(new RegExp(NODE_SWITCH_CODES.TOKEN_IN_ARGV))
  })

  it('快照如实反映运行态与模式', () => {
    const sw = createNodeSwitch({ ...base, spawn: vi.fn(() => 4242), kill: vi.fn() })
    expect(sw.snapshot()).toMatchObject({ running: false, managed: false, pid: null })
    sw.start('running')
    expect(sw.snapshot()).toMatchObject({ running: true, managed: true, pid: 4242, mode: 'running' })
  })
})
