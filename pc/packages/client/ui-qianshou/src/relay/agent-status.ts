/**
 * 面板读的 `qianshou.node-status.v1`，来自窗口里的专员，不来自数词进程。
 * 计数保持 0：这份投影不读派单账。收益保持空：派单帧没有报价。
 */

/** One attempt the resident runtime still owns. Fraction `0` means it has started and has not finished. */
export interface AgentRunningAttempt {
  readonly taskId: string
  readonly attempt: number
  readonly taskType: string
  readonly progress: number
  readonly progressEvents: number
  readonly startedAt: string
}

/** 专员接单投影成面板快照时用到的事实。 */
export interface AgentAcceptFacts {
  readonly pid: number
  readonly startedAtMs: number
  readonly nowMs: number
  readonly intake: 'running' | 'paused'
  readonly intakeReason?: string
  readonly intakeReasons?: readonly string[]
  readonly driver: 'idle' | 'running'
  readonly workerId: string | null
  readonly ownerId: number | null
  readonly core: string
  /** Attempts whose runner has not returned. Omitted means this projection has no task ledger. */
  readonly running?: readonly AgentRunningAttempt[]
}

/**
 * 把专员的接单状态写成面板已经会读的快照。
 * @param facts - 本进程里能读到的接单事实。
 * @returns `qianshou.node-status.v1` 对象。
 */
export function agentAcceptSnapshot(facts: AgentAcceptFacts): {
  schema: 'qianshou.node-status.v1'
  pid: number
  startedAt: string
  uptimeSeconds: number
  intakeReason: string | null
  intakeReasons: readonly string[]
  connection: {
    state: 'online' | 'connecting' | 'offline'
    reason: null
    core: string
    workerId: string | null
    ownerId: number | null
    mode: 'running' | 'paused'
    onlineSince: string | null
    onlineSeconds: number | null
  }
  current: AgentPanelTask | null
  tasks: readonly AgentPanelTask[]
  counters: {
    offersReceived: 0
    accepted: 0
    succeeded: 0
    failed: 0
    rejected: 0
    canceledByOwner: 0
  }
  lastRefusal: null
  recent: readonly []
  earnings: { estimatedNodeYuan: null; basis: string; note: string }
} {
  const uptimeSeconds = Math.max(0, (facts.nowMs - facts.startedAtMs) / 1000)
  const state = facts.workerId !== null ? 'online' : facts.driver === 'running' ? 'connecting' : 'offline'
  const started = new Date(facts.startedAtMs).toISOString()
  return {
    schema: 'qianshou.node-status.v1',
    pid: facts.pid,
    startedAt: started,
    uptimeSeconds,
    intakeReason: facts.intakeReason ?? null,
    intakeReasons: facts.intakeReasons ?? [],
    connection: {
      state,
      reason: null,
      core: facts.core,
      workerId: facts.workerId,
      ownerId: facts.ownerId,
      mode: facts.intake === 'running' ? 'running' : 'paused',
      onlineSince: state === 'online' ? started : null,
      onlineSeconds: state === 'online' ? uptimeSeconds : null,
    },
    ...panelTasks(facts.running ?? [], facts.nowMs),
    counters: {
      offersReceived: 0, accepted: 0, succeeded: 0, failed: 0, rejected: 0, canceledByOwner: 0,
    },
    lastRefusal: null,
    recent: [],
    earnings: {
      estimatedNodeYuan: null,
      basis: 'not-carried-in-dispatch-frame',
      note: '派单帧只带身份/输入/租约，不带报价；本节点不猜收益。',
    },
  }
}

/** Panel row for one in-flight attempt. Percent is the last reported fraction, not a guess. */
interface AgentPanelTask {
  readonly shardId: string
  readonly workloadId: string
  readonly attempt: number
  readonly taskType: string
  readonly startedAt: string
  readonly elapsedMs: number
  readonly progressPct: number
  readonly progressEvents: number
  readonly phase: 'started' | 'working' | 'done'
}

function panelTasks(running: readonly AgentRunningAttempt[], nowMs: number): {
  current: AgentPanelTask | null
  tasks: readonly AgentPanelTask[]
} {
  const tasks = running.map(task => {
    const dot = task.taskId.indexOf('.')
    const startedMs = Date.parse(task.startedAt)
    const fraction = Number.isFinite(task.progress) ? Math.max(0, Math.min(1, task.progress)) : 0
    const phase: AgentPanelTask['phase'] = fraction >= 1 ? 'done' : task.progressEvents > 1 ? 'working' : 'started'
    return {
      shardId: dot > 0 ? task.taskId.slice(dot + 1) : task.taskId,
      workloadId: dot > 0 ? task.taskId.slice(0, dot) : task.taskId,
      attempt: task.attempt,
      taskType: task.taskType,
      startedAt: task.startedAt,
      elapsedMs: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0,
      progressPct: Math.round(fraction * 100),
      progressEvents: task.progressEvents,
      phase,
    }
  })
  return { current: tasks[0] ?? null, tasks }
}
