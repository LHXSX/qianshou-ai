/**
 * 窗口自带的节点电源：进程跟着宿主起来，面板开关只关/开这一份进程。
 * 令牌仍只经 `createNodeSwitch` 放进子进程环境变量。
 */
import { createNodeSwitch, NODE_SWITCH_CODES, type NodeSwitch, type NodeSwitchConfig, type NodeSwitchMode } from './node-switch.ts'

/** 没有可用会话或仓库时的回答。 */
export const NODE_POWER_CODES = Object.freeze({
  NO_SESSION: 'NODE_SWITCH_NO_SESSION',
  NO_REPO: 'NODE_SWITCH_NO_REPO',
  NOT_READY: 'NODE_SWITCH_NOT_READY',
} as const)

/** 给面板和中继的电源状态。不含 pid，不含凭据。 */
export interface NodePowerView {
  readonly running: boolean
  readonly managed: boolean
  readonly mode: NodeSwitchMode | null
  readonly code?: string
}

/** 一次启动需要的材料。`token` 只交给开关，不进入返回值。 */
export interface NodePowerSession {
  readonly token: string
  readonly ownerId: number
  readonly coreUrl: string
  readonly repoPath: string
  readonly statusPort: number
}

/** 读会话失败时只带回一个码。 */
export type NodePowerSessionResult = NodePowerSession | { readonly code: string }

/** 电源的注入点。 */
export interface NodePowerOptions {
  readonly readSession: () => Promise<NodePowerSessionResult>
  readonly spawn: NodeSwitchConfig['spawn']
  readonly kill: NodeSwitchConfig['kill']
  readonly isAlive: NodeSwitchConfig['isAlive']
  /** 启动成功记下 pid，关掉时传入 `null`。 */
  readonly rememberPid?: (pid: number | null) => void
}

/** 面板开关调用的电源。 */
export interface NodePower {
  /** 当前开关位置。 */
  readonly view: () => NodePowerView
  /** 随窗口启动，或把开关拨到开。模式固定为 `running`。 */
  readonly turnOn: () => Promise<NodePowerView>
  /** 把开关拨到关。 */
  readonly turnOff: () => NodePowerView
  /**
   * 按开关目标位置动作。
   * @param on - `true` 启动，`false` 停止。
   * @returns 动作之后的电源状态。
   */
  readonly set: (on: boolean) => Promise<NodePowerView>
}

/**
 * 建一个节点电源。
 * @param options - 会话读取与进程注入。
 * @returns 电源。
 */
export function createNodePower(options: NodePowerOptions): NodePower {
  let switcher: NodeSwitch | null = null
  let code: string | undefined
  let starting: Promise<NodePowerView> | null = null

  const view = (): NodePowerView => {
    const snap = switcher?.snapshot()
    if (snap?.running === true) return { running: true, managed: true, mode: snap.mode }
    return { running: false, managed: false, mode: null, ...(code === undefined ? {} : { code }) }
  }

  const turnOff = (): NodePowerView => {
    switcher?.stop()
    switcher = null
    code = undefined
    options.rememberPid?.(null)
    return view()
  }

  const turnOn = (): Promise<NodePowerView> => {
    if (switcher?.snapshot().running === true) return Promise.resolve(view())
    if (starting !== null) return starting
    starting = startOnce().finally(() => { starting = null })
    return starting
  }

  const startOnce = async (): Promise<NodePowerView> => {
    const session = await options.readSession()
    if (!isSession(session)) {
      code = session.code
      return view()
    }
    switcher = createNodeSwitch({
      repoPath: session.repoPath,
      coreUrl: session.coreUrl,
      ownerId: session.ownerId,
      statusPort: session.statusPort,
      token: session.token,
      spawn: options.spawn,
      kill: options.kill,
      isAlive: options.isAlive,
    })
    try {
      const started = switcher.start('running')
      code = undefined
      options.rememberPid?.(started.pid)
      return view()
    } catch (error) {
      // 启动失败时开关停在关。错误文本可能被上层拼过，这里只留码。
      switcher = null
      code = codeOf(error)
      options.rememberPid?.(null)
      return view()
    }
  }

  return {
    view,
    turnOn,
    turnOff,
    set: (on: boolean) => on ? turnOn() : Promise.resolve(turnOff()),
  }
}

function isSession(value: NodePowerSessionResult): value is NodePowerSession {
  return 'token' in value
}

function codeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes(NODE_SWITCH_CODES.TOKEN_IN_ARGV)) return NODE_SWITCH_CODES.TOKEN_IN_ARGV
  if (message.includes(NODE_SWITCH_CODES.SPAWN_FAILED)) return NODE_SWITCH_CODES.SPAWN_FAILED
  return NODE_SWITCH_CODES.SPAWN_FAILED
}
