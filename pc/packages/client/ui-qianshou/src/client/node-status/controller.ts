/**
 * U1 状态机：一次轮询 = 一次 `accept`，**只有跨过快照之间的差异才产生提醒**。
 *
 * 为什么提醒必须是一次性的：主人此前正因为"面板一直闪"报过缺陷（C27）。所以这里的规则是硬的——
 * 1. 第一次读到快照只建基线，不为历史补放提醒；
 * 2. 事件按 key（`kind:shardId`）去重，**同一件事一辈子只提醒一次**，每次轮询都重放就是缺陷；
 * 3. 提醒有自己的停留时间（`alertMs`），到点自己消失，不留持续动画；
 * 4. 主人关掉之后不再打扰，且这个选择被记住。
 */
import {
  eventTime, nodePhase, verificationSettleable,
  type NodeCommand, type NodeCommandOutcome, type NodePhase, type NodeStatusReadout,
  type NodePowerState, type NodeStatusSnapshot, type NodeStatusTransport, type NodeTaskRecord,
} from './types.ts'

/** 四类事件 + 两个必须分开说的"非成功"分支。 */
export type NodeAlertKind = 'offer' | 'started' | 'finished' | 'finished-unverified' | 'failed' | 'refused' | 'canceled'

/** 一条一次性提醒。`at` 取自快照自己的时间，不是本地时钟编的。 */
export interface NodeAlert {
  readonly key: string
  readonly kind: NodeAlertKind
  readonly shardId: string | null
  readonly at: number
  readonly detail: string | null
}

/** 显示面订阅的状态。 */
export interface NodeStatusState {
  /** Changes on account/profile/connection invalidation, even when the next owner has the same revision. */
  readonly identityEpoch: number
  readonly readout: NodeStatusReadout | null
  readonly phase: NodePhase
  readonly alert: NodeAlert | null
  readonly alertsEnabled: boolean
  readonly polling: boolean
  readonly lastCommand: NodeCommandOutcome | null
  /** 窗口自带节点的开关。还没读到时是 `null`。 */
  readonly power: NodePowerState | null
  /** 开关正在拨，避免轮询把刚拨的位置盖掉。 */
  readonly powerBusy: boolean
}

/** 主人选择要记住的那一格。 */
export interface NodeAlertStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 构造参数。 */
export interface NodeStatusControllerOptions {
  readonly transport: NodeStatusTransport
  /** 轮询间隔，默认 2 秒（本机端点，读的是内存里的账）。 */
  readonly intervalMs?: number
  /** 一次提醒的停留时间，默认 6 秒。 */
  readonly alertMs?: number
  /** 时钟注入（测试用）。 */
  readonly now?: () => number
  /** 偏好存储；传 `null` 表示不持久化。 */
  readonly storage?: NodeAlertStorage | null
}

/** 提醒偏好的存储键。 */
export const ALERTS_PREFERENCE_KEY = 'qianshou.node.alerts'

const SEEN_KEY_LIMIT = 256

/**
 * 节点状态控制器：轮询 + 差异 → 一次性提醒 + 主人中止。
 */
export class NodeStatusController {
  private readonly transport: NodeStatusTransport
  private readonly intervalMs: number
  private readonly alertMs: number
  private readonly now: () => number
  private readonly storage: NodeAlertStorage | null
  private readonly listeners = new Set<(state: NodeStatusState) => void>()
  private readonly seen = new Set<string>()
  private state_: NodeStatusState
  private baseline: NodeStatusSnapshot | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private alertTimer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private generation = 0
  private disposed = false

  /**
   * @param options - 取数口、节拍与偏好存储。
   */
  constructor(options: NodeStatusControllerOptions) {
    this.transport = options.transport
    this.intervalMs = options.intervalMs ?? 2000
    this.alertMs = options.alertMs ?? 6000
    this.now = options.now ?? ((): number => Date.now())
    this.storage = options.storage === undefined ? defaultStorage() : options.storage
    this.state_ = {
      identityEpoch: 0,
      readout: null, phase: 'never-started', alert: null,
      alertsEnabled: this.storage?.getItem(ALERTS_PREFERENCE_KEY) !== 'off',
      polling: false, lastCommand: null, power: null, powerBusy: false,
    }
  }

  /**
   * Read the current immutable node status snapshot.
   * @returns The most recently published state.
   */
  state(): NodeStatusState {
    return this.state_
  }

  /**
   * 订阅状态变化。
   * @param listener - 每次状态更新都会收到新状态。
   * @returns 退订函数。
   */
  subscribe(listener: (state: NodeStatusState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 开始按间隔轮询；重复调用不会起第二个定时器。 */
  start(): void {
    if (this.disposed || this.timer !== null) return
    this.timer = setInterval(() => { void this.poll() }, this.intervalMs)
    void this.poll()
  }

  /** 停止轮询并清掉未到点的提醒计时器。 */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null }
    this.clearAlertTimer()
    this.listeners.clear()
  }

  /** Clear the retired account/device snapshot and immediately read the new identity. */
  invalidateIdentity(): void {
    if (this.disposed) return
    this.generation += 1
    this.polling = false
    this.baseline = null
    this.seen.clear()
    this.clearAlertTimer()
    this.publish({ identityEpoch: this.generation, readout: null, phase: 'connecting', alert: null, lastCommand: null,
      power: null, powerBusy: false, polling: false })
    void this.poll()
  }

  /**
   * 读一次端点并把结论交给状态机。
   * @param options - 取消信号。
   */
  async poll(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    if (this.disposed || this.polling) return
    const generation = this.generation
    this.polling = true
    this.publish({ polling: true })
    try {
      const signal = options.signal === undefined ? {} : { signal: options.signal }
      const readout = await this.transport.read(signal)
      if (!this.isCurrent(generation)) return
      this.accept(readout)
      if (this.isCurrent(generation) && !this.state_.powerBusy) {
        try {
          const power = await this.transport.power(signal)
          this.acceptPolledPower(generation, power)
        } catch {
          // 开关读失败时留着上一次的位置。
        }
      }
    } finally {
      if (this.isCurrent(generation)) {
        this.polling = false
        this.publish({ polling: false })
      }
    }
  }

  /**
   * 应用一次读取结论（轮询与推送共用同一个入口）。
   * @param readout - 读取结论。
   */
  accept(readout: NodeStatusReadout): void {
    if (this.disposed) return
    if (readout.kind === 'unreachable') {
      // 节点没在跑时不留基线：重新上线后要先建基线，不为掉线期间的历史补放提醒。
      this.baseline = null
      this.publish({ readout, phase: nodePhase(readout), alert: null })
      return
    }
    const snapshot = readout.snapshot
    const previous = this.baseline
    this.baseline = snapshot
    const alert = this.deriveAlert(previous, snapshot)
    this.publish({ readout, phase: nodePhase(readout), ...(alert === null ? {} : { alert }) })
    if (alert !== null) this.armAlertTimer(alert.key)
  }

  /**
   * 发主人中止命令（复用端点命令，不另造一套）。
   * @param target - `all` 或一个分片 id。
   * @returns 命令结果。
   */
  async abort(target: string): Promise<NodeCommandOutcome> {
    if (this.disposed) return { ok: false, code: 'CONTROLLER_DISPOSED' }
    const generation = this.generation
    const command: NodeCommand = { command: 'abort', target }
    const outcome = await this.transport.command(command)
    if (this.isCurrent(generation)) this.publish({ lastCommand: outcome })
    return outcome
  }

  /**
   * 拨节点开关。
   * @param on - `true` 启动窗口自带的节点，`false` 停掉它。
   */
  async setPower(on: boolean): Promise<void> {
    if (this.disposed || this.state_.powerBusy) return
    const generation = this.generation
    this.publish({ powerBusy: true })
    try {
      const power = await this.transport.setPower(on)
      if (this.isCurrent(generation)) this.publish({ power })
    } finally {
      if (this.isCurrent(generation)) this.publish({ powerBusy: false })
    }
  }

  /** 关掉提醒并记住这个选择。 */
  dismissAlerts(): void {
    this.clearAlertTimer()
    this.storage?.setItem(ALERTS_PREFERENCE_KEY, 'off')
    this.publish({ alert: null, alertsEnabled: false })
  }

  /** 重新打开提醒。 */
  enableAlerts(): void {
    this.storage?.setItem(ALERTS_PREFERENCE_KEY, 'on')
    this.publish({ alertsEnabled: true })
  }

  private publish(patch: Partial<NodeStatusState>): void {
    if (this.disposed) return
    this.state_ = { ...this.state_, ...patch }
    for (const listener of this.listeners) listener(this.state_)
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }

  private acceptPolledPower(generation: number, power: NodePowerState): void {
    if (this.isCurrent(generation) && !this.state_.powerBusy) this.publish({ power })
  }

  private clearAlertTimer(): void {
    if (this.alertTimer !== null) { clearTimeout(this.alertTimer); this.alertTimer = null }
  }

  private armAlertTimer(key: string): void {
    this.clearAlertTimer()
    this.alertTimer = setTimeout(() => {
      this.alertTimer = null
      if (this.state_.alert?.key === key) this.publish({ alert: null })
    }, this.alertMs)
  }

  /**
   * 把两份快照之间的差异翻成**至多一条**提醒（优先级：失败 > 拒绝 > 中止 > 完成 > 新单 > 开始）。
   * @param previous - 上一次的快照；`null` 表示这是基线。
   * @param next - 这一次的快照。
   * @returns 一条一次性提醒，或 `null`。
   */
  private deriveAlert(previous: NodeStatusSnapshot | null, next: NodeStatusSnapshot): NodeAlert | null {
    if (previous === null || !this.state_.alertsEnabled) return null
    const fallback = this.now()
    const refusal = next.lastRefusal
    const refusalChanged = refusal !== null && (previous.lastRefusal === null
      || refusal.at !== previous.lastRefusal.at || refusal.code !== previous.lastRefusal.code)
    const settled = next.recent.find(record => record.outcome === 'succeeded')
    const reasonOf = (record: NodeTaskRecord | null | undefined): string | null => record?.reason ?? null
    if (next.counters.failed > previous.counters.failed || (refusalChanged && refusal.kind === 'failed')) {
      return this.once('failed', refusal?.shardId ?? null, eventTime(refusal?.at, fallback), refusal === null ? null : `${refusal.code} ${refusal.reason}`)
    }
    if (next.counters.rejected > previous.counters.rejected || (refusalChanged && refusal.kind === 'refused')) {
      return this.once('refused', refusal?.shardId ?? null, eventTime(refusal?.at, fallback), refusal === null ? null : `${refusal.code} ${refusal.reason}`)
    }
    if (next.counters.canceledByOwner > previous.counters.canceledByOwner || (refusalChanged && refusal.kind === 'canceled-by-owner')) {
      return this.once('canceled', refusal?.shardId ?? null, eventTime(refusal?.at, fallback), null)
    }
    if (next.counters.succeeded > previous.counters.succeeded) {
      const kind = verificationSettleable(settled?.verification ?? null) ? 'finished' : 'finished-unverified'
      return this.once(kind, settled?.shardId ?? null, eventTime(settled?.at, fallback), reasonOf(settled))
    }
    if (next.counters.offersReceived > previous.counters.offersReceived) {
      const task = next.current
      return this.once('offer', task?.shardId ?? null, eventTime(task?.startedAt, fallback), task?.taskType ?? null)
    }
    const known = new Set(previous.tasks.map(task => task.shardId))
    const started = next.tasks.find(task => task.progressEvents > 0 && !known.has(task.shardId))
    if (started !== undefined) {
      return this.once('started', started.shardId, eventTime(started.startedAt, fallback), started.taskType)
    }
    return null
  }

  /** 同一件事只提醒一次：key 见过就直接丢掉。 */
  private once(kind: NodeAlertKind, shardId: string | null, at: number, detail: string | null): NodeAlert | null {
    const key = `${kind}:${shardId ?? 'node'}`
    if (this.seen.has(key)) return null
    if (this.seen.size >= SEEN_KEY_LIMIT) {
      const oldest = this.seen.values().next()
      if (!oldest.done) this.seen.delete(oldest.value)
    }
    this.seen.add(key)
    return { key, kind, shardId, at, detail }
  }
}

/** 默认偏好存储：浏览器里用 `localStorage`，没有就退成不持久化。 */
function defaultStorage(): NodeAlertStorage | null {
  try {
    const store = Reflect.get(globalThis, 'localStorage') as Storage | null | undefined
    if (store === undefined || store === null) return null
    return { getItem: key => store.getItem(key), setItem: (key, value) => { store.setItem(key, value) } }
  } catch {
    return null
  }
}
