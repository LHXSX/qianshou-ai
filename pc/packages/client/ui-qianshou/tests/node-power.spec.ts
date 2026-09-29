/** 窗口自带节点：没会话不起进程；开着时模式是 running；令牌不进 argv。 */
import { describe, expect, it, vi } from 'vitest'
import { daemonLaunch } from '../src/relay/host-runtime.ts'
import { createNodePower, NODE_POWER_CODES, type NodePowerOptions } from '../src/relay/node-power.ts'
import { findNodeRepo, ownerIdFromAccessToken } from '../src/relay/node-session.ts'

const session = {
  token: 'TOKEN-abc', ownerId: 167, coreUrl: 'https://qianshousuanli.com', repoPath: '/repo', statusPort: 47625,
}

function jwt(payload: Record<string, unknown>): string {
  const part = (value: Record<string, unknown>): string => btoa(JSON.stringify(value)).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(payload)}.sig`
}

describe('ownerIdFromAccessToken', () => {
  it('从 sub 读机主 id，过期的凭据不用', () => {
    const now = 1_790_000_000_000
    expect(ownerIdFromAccessToken(jwt({ sub: '167', exp: 1_790_000_100 }), now)).toBe(167)
    expect(ownerIdFromAccessToken(jwt({ sub: '167', exp: 1_789_000_000 }), now)).toBeNull()
    expect(ownerIdFromAccessToken('not-a-jwt', now)).toBeNull()
  })
})

describe('findNodeRepo', () => {
  it('环境变量优先，否则从起点往上找到带守护进程的仓库', () => {
    const exists = (path: string) => path === '/work/apps/qianshou-node/node-daemon.mts' || path === '/env-repo/apps/qianshou-node/node-daemon.mts'
    expect(findNodeRepo(exists, '/env-repo', '/work/packages/client')).toBe('/env-repo')
    expect(findNodeRepo(() => false, '/missing', '/other/place')).toBeNull()
    expect(findNodeRepo(exists, undefined, '/work/packages/client/ui-qianshou/lib')).toBe('/work')
  })
})

describe('daemonLaunch', () => {
  it('tsx 换成当前可执行文件，令牌只留在环境变量', () => {
    const launched = daemonLaunch('/usr/bin/node', 'node_modules/.bin/tsx', ['apps/qianshou-node/node-daemon.mts', '--owner', '167'], {
      cwd: '/repo',
      env: { QIANSHOU_NODE_TOKEN: 'TOKEN-abc' },
    })
    expect(launched.bin).toBe('/usr/bin/node')
    expect(launched.argv.join(' ')).not.toContain('TOKEN-abc')
    expect(launched.argv[0]).toBe('/repo/node_modules/tsx/dist/cli.mjs')
    expect(launched.env.QIANSHOU_NODE_TOKEN).toBe('TOKEN-abc')
    expect(launched.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('argv 里混进令牌就拒绝', () => {
    expect(() => daemonLaunch('/usr/bin/node', 'node_modules/.bin/tsx', ['TOKEN-abc'], {
      cwd: '/repo', env: { QIANSHOU_NODE_TOKEN: 'TOKEN-abc' },
    })).toThrow(/NODE_SWITCH_TOKEN_IN_ARGV/)
  })
})

describe('createNodePower', () => {
  it('没有会话时不起进程', async () => {
    const spawn = vi.fn(() => 1)
    const power = createNodePower({
      readSession: () => Promise.resolve({ code: NODE_POWER_CODES.NO_SESSION }),
      spawn, kill: vi.fn(), isAlive: () => true,
    })
    await expect(power.turnOn()).resolves.toMatchObject({ running: false, code: NODE_POWER_CODES.NO_SESSION })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('随窗口启动时用 running，令牌不进 argv，再开一次不另起进程', async () => {
    const spawn = vi.fn<NodePowerOptions['spawn']>(() => 4242)
    const power = createNodePower({
      readSession: () => Promise.resolve(session),
      spawn, kill: vi.fn(), isAlive: () => true,
    })
    await power.turnOn()
    await power.turnOn()
    expect(spawn).toHaveBeenCalledTimes(1)
    const args = spawn.mock.calls[0]?.[1] ?? []
    expect(args[args.indexOf('--mode') + 1]).toBe('running')
    expect(args.join(' ')).not.toContain('TOKEN-abc')
    expect(spawn.mock.calls[0]?.[2].env.QIANSHOU_NODE_TOKEN).toBe('TOKEN-abc')
    expect(power.view()).toMatchObject({ running: true, mode: 'running' })
  })

  it('关掉时向本开关的 pid 发 SIGTERM', async () => {
    const kill = vi.fn()
    const remembered: Array<number | null> = []
    const power = createNodePower({
      readSession: () => Promise.resolve(session),
      spawn: vi.fn(() => 4242), kill, isAlive: () => true,
      rememberPid: pid => { remembered.push(pid) },
    })
    await power.turnOn()
    expect(power.turnOff()).toMatchObject({ running: false })
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(remembered).toEqual([4242, null])
  })
})
