/**
 * 手机端的对话控制器：把界面与「LLM 调用层 + 本地存储」之间的状态迁移集中在这里。
 *
 * 为什么要有这一层，而不是把逻辑写进 `App.tsx`：
 * 1. 让真实行为可被测试。流式追加、按「停止」静默结束、会话落盘、密钥未配置的
 *    引导——这些都是**状态迁移**，放在组件里就只能靠渲染副作用去猜。
 * 2. 组件的职责退回到「渲染快照 + 转发事件」，界面部分不需要知道 SSE 长什么样。
 *
 * 这一层不碰 `fetch`，也不碰 `localStorage`：它只用 `llm.ts` 与 `store.ts` 暴露的
 * 契约（那两个文件在本任务里是锁定的）。因此测试可以注入一个假的 `streamChat`
 * 和一个假的存储，在毫秒级把边界跑完；真实网络与真实存储的行为由 `llm.spec.ts`
 * 与 `store.spec.ts` 在真实 socket 上验证。
 */
import {
  ChatFailure,
  FAILURE_COPY,
  PROVIDER_TEMPLATES,
  streamChat,
  type ChatMessage,
  type ChatStream,
  type ConnectionSettings,
  type ModelOption,
  type SendOptions,
} from './llm.ts'
import {
  loadSecret,
  loadSessions,
  loadSettings,
  newSessionId,
  saveSecret,
  saveSessions,
  saveSettings,
  titleFrom,
  type StoredSession,
} from './store.ts'

/**
 * 发送请求时注入的系统提示；用户看不到，也不落盘进可编辑的消息列表。
 *
 * 三条约束各自的由来：
 * 1. **身份**——用户问「你是什么模型」时必须答「千手大模型」，所以这里先给死身份，
 *    而不是让模型按底层权重自由发挥；界面要求它自称千手，产品名与回答必须一致。
 * 2. **不编造**——不确定就直说。这条是安全底线：宁可说"不知道"，也不能给看起来
 *    合理的假数字。
 * 3. **排版**——手机上没有富文本，段落空行加少量图标才读得下去；图标给上限，
 *    否则模型会每行都插一个，屏幕立刻变花。
 */
export const SYSTEM_PROMPT =
  '你是千手 AI 助手，由千手团队打造的千手大模型驱动。' +
  '有人问你是谁、你是什么模型、用的什么底座时，就回答「我是千手大模型」，' +
  '不要提及任何其他公司或第三方模型的名字。' +
  '用简洁、口语化的中文回答；不确定就直说，不要编造。' +
  '排版：手机屏幕窄，尽量少切段落——一个意思说完再用空行分开，不要每句都空行；' +
  '需要列举时用短行而不是长段落。' +
  '可以少量用图标（emoji）做要点标记，一条回复最多两三个，只在结论或关键步骤处用，' +
  '不要每行都加，也不要拿图标当装饰。'

/** 发起一次流式对话的函数签名；测试注入假实现，生产用 `streamChat` 本身。 */
export type StreamChatFn = (options: SendOptions, handlers: Parameters<typeof streamChat>[1]) => ChatStream

/** 界面渲染所需的全部状态。每次真实变化都会换一个新对象，供 `useSyncExternalStore` 比较。 */
/**
 * 对话的阶段。
 *
 * - `idle`：没有在跑
 * - `thinking`：已发出请求，还没收到第一个字（模型在思考或首字延迟）
 * - `replying`：正在逐字吐出回复
 * - `failed`：最近一次以失败告终
 * - `aborted`：用户主动停止
 */
export type ChatPhase = 'idle' | 'thinking' | 'replying' | 'failed' | 'aborted'

export interface ChatSnapshot {
  readonly settings: ConnectionSettings
  /** 当前会话的消息（不含系统提示）；每条都带创建时刻。 */
  readonly messages: readonly ChatEntry[]
  /** 是否正在收流；此时发送按钮换成「停止」。 */
  readonly streaming: boolean
  /**
   * 收流处于哪个阶段。
   *
   * `thinking` 与 `replying` 的区别就是"还没吐出第一个字"与"已经在吐字"——
   * 界面据此显示不同的状态提示，而不是从点击到结束都只有一句"正在回复…"。
   */
  readonly phase: ChatPhase
  /** 最近一次失败；用户看的是它的中文说明，不是技术堆栈。 */
  readonly failure: ChatFailure | null
  /** 已落盘的会话列表（已按最近更新排序）。 */
  readonly sessions: readonly StoredSession[]
  /** 当前会话 id；可以是尚未落盘的新会话。 */
  readonly sessionId: string
}

/**
 * 一条带时间戳的消息。
 *
 * 时间戳在消息**创建时**打一次并跟着它走，而不是渲染时取 `Date.now()`：
 * 后者会让时间随每次重渲染变化，同一个气泡在流式追加期间显示的分钟数会来回跳。
 */
export interface ChatEntry extends ChatMessage {
  /** 创建时刻（毫秒）。老数据里可能没有。 */
  readonly at?: number
}

/** 构造控制器时可注入的依赖；省略即使用真实实现。 */
export interface ChatControllerDeps {
  readonly stream?: StreamChatFn
  readonly settings?: ConnectionSettings
  readonly secret?: string
  readonly sessions?: readonly StoredSession[]
}

/**
 * 把连续的同角色消息压成一组，渲染时一组只出一个气泡。
 * 合并后保留**第一条**的时间戳：那是这组内容的起始时刻。
 * @param messages - 会话里的原始消息。
 * @returns 按角色分组后的消息。
 */
export function groupRuns(messages: readonly ChatEntry[]): readonly ChatEntry[] {
  const runs: ChatEntry[] = []
  for (const message of messages) {
    const previous = runs[runs.length - 1]
    if (previous !== undefined && previous.role === message.role) {
      runs[runs.length - 1] = {
        role: previous.role,
        content: `${previous.content}\n\n${message.content}`,
        at: previous.at,
      }
      continue
    }
    runs.push(message)
  }
  return runs
}

/** 一个失败对象的可读文案；非空文案直接用，空文案回退到通用说明。 */
export function failureCopy(failure: ChatFailure): string {
  return failure.message.trim().length > 0 ? failure.message : FAILURE_COPY['invalid-response']
}

/** 空串或纯空白的端点/模型视为未填写。 */
function blank(value: string): boolean {
  return value.trim().length === 0
}

/**
 * 对话控制器。
 *
 * 生命周期很小：`send()` 发起一次流，`abort()` 取消它，`newSession()` / `openSession()`
 * 切换会话。所有状态变化都会 `subscribe` 通知一次，React 端用快照做渲染。
 */
export class ChatController {
  private currentSettings: ConnectionSettings
  private currentSecret: string
  private currentSessions: readonly StoredSession[]
  private currentSessionId: string
  private currentMessages: readonly ChatEntry[]
  private currentStreaming = false
  /**
   * 最近一次收流是否由用户主动停止（而不是失败或正常结束）。
   *
   * 单独记一位而不是复用 `failure`：停止是**用户的意图**，不该在界面上留下
   * 错误痕迹；但也不该被当成"正常完成"——半截回答需要一个中性的收尾状态。
   */
  private currentAborted = false
  private currentFailure: ChatFailure | null = null
  private currentStream: ChatStream | null = null
  private snapshotCache: ChatSnapshot | null = null
  private readonly listeners = new Set<() => void>()
  private readonly stream: StreamChatFn

  /** @param deps - 可注入的流实现与初始状态；省略时从本机存储读取。 */
  constructor(deps: ChatControllerDeps = {}) {
    this.stream = deps.stream ?? streamChat
    this.currentSettings = deps.settings ?? loadSettings()
    this.currentSecret = deps.secret ?? loadSecret()
    this.currentSessions = deps.sessions ?? loadSessions()
    const latest = this.currentSessions[0]
    this.currentSessionId = latest?.id ?? newSessionId()
    this.currentMessages = latest?.messages ?? []
  }

  /** 订阅状态变化；返回取消订阅函数。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 当前快照；同一版本内返回同一个对象引用（`useSyncExternalStore` 要求）。 */
  snapshot = (): ChatSnapshot => {
    this.snapshotCache ??= {
      settings: this.currentSettings,
      messages: this.currentMessages,
      streaming: this.currentStreaming,
      phase: this.phase(),
      failure: this.currentFailure,
      sessions: this.currentSessions,
      sessionId: this.currentSessionId,
    }
    return this.snapshotCache
  }

  /**
   * 当前阶段。
   *
   * 判定顺序有讲究：**正在收流时以流状态为准**，因为一次新的发送可能发生在
   * 上一次失败之后——那时 `failure` 还没被清掉，但用户看到的应当是"正在回复"，
   * 而不是上一次的那条错误。
   * @returns 当前阶段。
   */
  phase(): ChatPhase {
    if (this.currentStreaming) {
      return this.hasAssistantText() ? 'replying' : 'thinking'
    }
    if (this.currentAborted === true) return 'aborted'
    if (this.currentFailure !== null) return 'failed'
    return 'idle'
  }

  /** 最后一条助手消息是否已经有内容——决定是"在思考"还是"在回复"。 */
  private hasAssistantText(): boolean {
    const last = this.currentMessages[this.currentMessages.length - 1]
    return last !== undefined && last.role === 'assistant' && last.content.length > 0
  }

  /** 是否正在收流。 */
  isStreaming(): boolean {
    return this.currentStreaming
  }

  /** 是否有密钥可发；本地自建网关可能不需要密钥。 */
  hasKey(): boolean {
    return !this.requiresKey() || !blank(this.currentSecret)
  }

  private requiresKey(): boolean {
    return PROVIDER_TEMPLATES[this.currentSettings.providerId]?.requiresKey ?? true
  }

  /** 当前可选的模型清单：优先取设置里选定的服务商模板，模板没给就用已配置的模型。 */
  modelOptions(): readonly ModelOption[] {
    const template = PROVIDER_TEMPLATES[this.currentSettings.providerId]
    const configured: ModelOption = {
      id: this.currentSettings.model,
      name: this.currentSettings.model,
    }
    const models = template?.models ?? []
    if (models.length === 0) return blank(this.currentSettings.model) ? [] : [configured]
    // 配置的模型不在模板里（用户手填过）时也要能选中它，否则界面会显示一个
    // 与实际请求模型不一致的名字。
    return models.some(m => m.id === configured.id) ? models : [...models, configured]
  }

  /** 当前模型的显示名；没有配置时给出可操作的提示文案，而不是空白。 */
  modelLabel(): string {
    const model = this.currentSettings.model
    if (!blank(model)) {
      return this.modelOptions().find(option => option.id === model)?.name ?? model
    }
    return '未配置模型'
  }

  /** 当前配置是否完整到可以发请求：端点、模型，以及该服务商要求的密钥。 */
  readiness(): { readonly ok: boolean; readonly failure: ChatFailure | null } {
    if (blank(this.currentSettings.baseUrl)) return { ok: false, failure: this.fail('no-endpoint') }
    if (this.requiresKey() && blank(this.currentSecret)) return { ok: false, failure: this.fail('no-key') }
    if (blank(this.currentSettings.model)) return { ok: false, failure: this.fail('no-endpoint') }
    return { ok: true, failure: null }
  }

  /**
   * 发送一条用户消息并发起流式回答。
   *
   * 失败原因分两种：配置不完整（缺密钥/缺端点）在**发出请求之前**就定下来，用户
   * 看到的是去设置页的引导；网络与服务商错误由流回调给出，文案同样来自
   * `FAILURE_COPY`，绝不把技术堆栈透出来。
   * @param text - 用户输入原文。
   * @returns 是否真的发起了请求（配置不全时为 `false`）。
   */
  send(text: string): boolean {
    const content = text.trim()
    if (content.length === 0 || this.currentStreaming) return false

    const ready = this.readiness()
    if (!ready.ok) {
      this.currentFailure = ready.failure
      this.emit()
      return false
    }

    const outgoing: ChatEntry[] = [...this.currentMessages, { role: 'user', content, at: Date.now() }]
    // 出网只带线上约定的两个字段：`at` 是本机的展示用书签，不进请求体。
    const request: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...outgoing.map(({ role, content: text }) => ({ role, content: text })),
    ]
    const placeholder: ChatEntry = { role: 'assistant', content: '', at: Date.now() }
    this.currentFailure = null
    this.currentStreaming = true
    this.currentMessages = [...outgoing, placeholder]
    this.emit()

    const handle = this.stream(
      {
        baseUrl: this.currentSettings.baseUrl,
        apiKey: this.currentSecret,
        model: this.currentSettings.model,
        messages: request,
      },
      {
        onDelta: (delta) => {
          this.appendToAnswer(delta)
        },
        onDone: () => {
          this.finishStream(false)
        },
        onError: (failure) => {
          // 用户按「停止」是预期行为，不是故障：安静收尾，不弹任何错误。
          if (failure.kind === 'aborted') {
            this.finishStream(true)
            return
          }
          this.appendFailure(failure)
          this.finishStream(false)
        },
      },
    )
    this.currentStream = handle
    // 调用方不 await 这个句柄，所以这里显式兜住拒绝，避免未处理拒绝冒到控制台；
    // 失败本身已经通过 `onError` 进入界面状态。
    handle.completed.catch(() => {})
    return true
  }

  /**
   * 取消进行中的流。`aborted` 由流回调异步送达，这里只发信号、不改文案。
   */
  abort(): void {
    this.currentStream?.abort()
  }

  /** 开一条空会话；不清空已落盘的历史。 */
  newSession(): void {
    this.abort()
    this.currentSessionId = newSessionId()
    this.currentMessages = []
    this.currentFailure = null
    this.currentStreaming = false
    this.currentStream = null
    this.emit()
  }

  /**
   * 切到一条已存在的会话，恢复它的消息。
   * @param id - 会话 id；不存在时不做任何事。
   */
  openSession(id: string): void {
    const target = this.currentSessions.find(session => session.id === id)
    if (target === undefined || id === this.currentSessionId) return
    this.abort()
    this.currentSessionId = id
    this.currentMessages = target.messages
    this.currentFailure = null
    this.currentStreaming = false
    this.currentStream = null
    this.emit()
  }

  /**
   * 保存连接设置、密钥，并用新设置重建发送目标。
   * @param settings - 端点与模型。
   * @param secret - 密钥；空串表示清除。
   * @returns 写入本机存储时是否成功（配额写满会失败）。
   */
  saveConnection(settings: ConnectionSettings, secret: string): boolean {
    try {
      saveSettings(settings)
      // 密钥单独存：连接设置那份里永远不出现密钥。
      saveSecret(secret)
    } catch {
      return false
    }
    this.currentSettings = settings
    this.currentSecret = secret
    this.currentFailure = null
    this.emit()
    return true
  }

  /** 当前密钥原文；设置页需要回填输入框。 */
  secretValue(): string {
    return this.currentSecret
  }

  /** 构造一次失败对象；文案一律来自 `FAILURE_COPY`。 */
  private fail(kind: ChatFailure['kind']): ChatFailure {
    return new ChatFailure(kind, FAILURE_COPY[kind])
  }

  /** 把增量追加到最后一个助手气泡上。 */
  private appendToAnswer(delta: string): void {
    const last = this.currentMessages[this.currentMessages.length - 1]
    if (last === undefined || last.role !== 'assistant') return
    this.currentMessages = [
      ...this.currentMessages.slice(0, -1),
      { role: 'assistant', content: last.content + delta, at: last.at },
    ]
    this.emit()
  }

  /** 流失败：把原因挂到状态上，并丢掉空的占位气泡（避免留一个空框）。 */
  private appendFailure(failure: ChatFailure): void {
    this.currentFailure = failure
    const last = this.currentMessages[this.currentMessages.length - 1]
    if (last?.role === 'assistant' && last.content.length === 0) {
      this.currentMessages = this.currentMessages.slice(0, -1)
    }
    this.emit()
  }

  /** 收流收尾：落盘、清掉流句柄，并按需丢弃空气泡。 */
  private finishStream(aborted: boolean): void {
    this.currentAborted = aborted
    if (aborted) {
      const last = this.currentMessages[this.currentMessages.length - 1]
      if (last?.role === 'assistant' && last.content.length === 0) {
        this.currentMessages = this.currentMessages.slice(0, -1)
      }
    }
    this.currentStreaming = false
    this.currentStream = null
    this.persist()
    this.emit()
  }

  /** 把当前会话写进本机存储；失败不抛给界面，避免一次写盘失败毁掉整屏对话。 */
  private persist(): void {
    const messages = this.currentMessages
    if (messages.length === 0) return
    const record: StoredSession = {
      id: this.currentSessionId,
      title: titleFrom(messages),
      updatedAt: Date.now(),
      messages,
    }
    const next = [record, ...this.currentSessions.filter(session => session.id !== record.id)]
    try {
      saveSessions(next)
    } catch {
      // 存储不可用（隐私模式/配额写满）：内存里的对话仍然成立，只是这次没落盘。
      return
    }
    this.currentSessions = next
  }

  /** 通知订阅者：换掉快照缓存，再逐个通知。 */
  private emit(): void {
    this.snapshotCache = null
    for (const listener of this.listeners) listener()
  }
}
