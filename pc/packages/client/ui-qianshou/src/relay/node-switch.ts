/**
 * 算力节点开关：让面板能"开/关节点"，而不必回到命令行。
 *
 * **本模块刻意不碰任何 Node API**（不 require、不 process.kill）：
 * 这个包按客户端 tsconfig 编译，没有 Node 类型 —— 上次直接调 `process.kill` 就在这里编译不过。
 * 所以三件事全部由宿主侧**注入**：`spawn`（起进程）、`kill`（停进程）、`isAlive`（存活探针）。
 * 好处还有一个：测试可以完全脱离真实进程来钉判定规则。
 *
 * 安全约束（每条都对应本会话踩过的真实坑）：
 * 1. **令牌只经环境变量注入，绝不进 argv** —— 会话中途我犯过"token 写在命令行上"的错，
 *    任何 `ps` 的人都能看见。起进程前**逐参数断言** argv 不含令牌（并有测试钉住）。
 * 2. **默认 `paused`**：开关只让节点**上线待命 + 声明能力**，**不自动接单**；接单是**另一个显式动作**。
 * 3. **不认识的状态如实说**：不是本开关起的 ⇒ `NODE_SWITCH_NOT_MANAGED`，**绝不假装能停它**。
 * 4. **幂等**：已启动再按启动 ⇒ 返回既有 pid，不重复起第二个
 *    （同机多节点会因机器指纹共用 workerId 互相顶掉，今天实测过）。
 */

export const NODE_SWITCH_CODES = Object.freeze({
  NOT_MANAGED: 'NODE_SWITCH_NOT_MANAGED',
  TOKEN_IN_ARGV: 'NODE_SWITCH_TOKEN_IN_ARGV',
  ALREADY_RUNNING: 'NODE_SWITCH_ALREADY_RUNNING',
  SPAWN_FAILED: 'NODE_SWITCH_SPAWN_FAILED',
} as const)

export type NodeSwitchMode = 'paused' | 'running'
export type NodeSwitchSignal = 'SIGTERM' | 'SIGKILL'

export interface NodeSwitchConfig {
  /** 节点仓库根目录（`apps/qianshou-node` 所在的那个）。 */
  readonly repoPath: string
  readonly coreUrl: string
  readonly ownerId: number
  /** 状态端点端口；与面板读的是同一个。 */
  readonly statusPort: number
  /** 节点凭据。**只作为子进程环境变量**，绝不拼进命令行。 */
  readonly token: string
  /** 起进程：返回 pid。由宿主侧提供（那里有 Node 类型）。 */
  readonly spawn: (command: string, args: readonly string[], options: { cwd: string, env: Record<string, string | undefined>, detached: boolean }) => number
  /** 停进程。由宿主侧提供。 */
  readonly kill: (pid: number, signal: NodeSwitchSignal) => void
  /** 存活探针。由宿主侧提供。 */
  readonly isAlive: (pid: number) => boolean
}

export interface NodeSwitchSnapshot {
  readonly running: boolean
  readonly managed: boolean
  readonly pid: number | null
  readonly mode: NodeSwitchMode | null
  readonly startedAt: string | null
}

export interface NodeSwitch {
  /** 上线。已启动则幂等返回既有信息。 */
  readonly start: (mode?: NodeSwitchMode) => NodeSwitchSnapshot
  /** 关闭。不是本开关起的 ⇒ 如实报 `NOT_MANAGED`。 */
  readonly stop: () => { readonly stopped: boolean, readonly code?: string, readonly detail?: string }
  readonly snapshot: () => NodeSwitchSnapshot
}

export function createNodeSwitch(config: NodeSwitchConfig): NodeSwitch {
  let pid: number | null = null
  let mode: NodeSwitchMode | null = null
  let startedAt: string | null = null

  const stillAlive = (): boolean => {
    if (pid === null) return false
    if (config.isAlive(pid)) return true
    pid = null; mode = null; startedAt = null
    return false
  }

  return {
    snapshot(): NodeSwitchSnapshot {
      const alive = stillAlive()
      return {
        running: alive,
        managed: alive,
        pid: alive ? pid : null,
        mode: alive ? mode : null,
        startedAt: alive ? startedAt : null,
      }
    },

    start(requested: NodeSwitchMode = 'paused'): NodeSwitchSnapshot {
      if (stillAlive()) return { running: true, managed: true, pid, mode, startedAt }
      const args: string[] = [
        'node_modules/.bin/tsx', 'apps/qianshou-node/node-daemon.mts',
        '--core', config.coreUrl,
        '--owner', String(config.ownerId),
        '--mode', requested,
        '--status-port', String(config.statusPort),
      ]
      // 令牌不得出现在命令行里（它只能走 env）——踩过的坑，做成断言。
      if (config.token !== '' && args.some(arg => arg.includes(config.token))) {
        throw new Error(`${NODE_SWITCH_CODES.TOKEN_IN_ARGV}: 令牌不得出现在 argv 中`)
      }
      const command = args[0] ?? 'node_modules/.bin/tsx'
      let child: number
      try {
        child = config.spawn(command, args.slice(1), {
          cwd: config.repoPath,
          env: { ...flattenEnv(), QIANSHOU_NODE_TOKEN: config.token },
          detached: true,
        })
      } catch (error) {
        throw new Error(`${NODE_SWITCH_CODES.SPAWN_FAILED}: ${(error as Error).message}`)
      }
      pid = child; mode = requested; startedAt = new Date().toISOString()
      return { running: true, managed: true, pid, mode, startedAt }
    },

    stop() {
      if (pid === null || !stillAlive()) {
        return { stopped: false, code: NODE_SWITCH_CODES.NOT_MANAGED, detail: '本开关没有在管的节点进程' }
      }
      const target = pid
      config.kill(target, 'SIGTERM')
      pid = null; mode = null; startedAt = null
      return { stopped: true, detail: `已向 pid=${target} 发 SIGTERM` }
    },
  }
}

/** 继承宿主环境（不含令牌）。宿主若没提供 `process.env`，就退化为空表并在 env 里只放令牌。 */
function flattenEnv(): Record<string, string | undefined> {
  const candidate = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return candidate?.env ?? {}
}
