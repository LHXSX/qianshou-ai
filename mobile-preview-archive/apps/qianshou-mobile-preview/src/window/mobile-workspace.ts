/** Mobile conversation routing through real agent Sessions or the existing durable PC controller. */
import { PcWindowController, type PcWindowPort, type WindowTranscript } from '@deepseek-ai/dsh-client-pc-window-bridge'
import { decideTrigger } from '@deepseek-ai/dsh-client-compute-trigger'
import type { MobileAdmission, MobileConversationTarget, MobileWorkspaceOptions, MobileWorkspaceSnapshot } from './mobile-workspace-types.ts'

interface Conversation {
  readonly target: MobileConversationTarget
  readonly port?: PcWindowPort
  readonly pc?: PcWindowController
  readonly replacePort?: (port: PcWindowPort) => void
  turns: WindowTranscript['turns']
  admissions: MobileAdmission[]
  status: MobileWorkspaceSnapshot['status']
  pending: number
  tail: Promise<void>
  connecting: Promise<void>
  draft: MobileWorkspaceSnapshot['draft']
  error: MobileWorkspaceSnapshot['error']
  readRequest: number
  observeUntil: number | null
  observingSince: number | null
  sawRunning: boolean
}

function key(target: MobileConversationTarget): string {
  return JSON.stringify(target.kind === 'agent'
    ? ['agent', target.binding.accountId, target.binding.sessionId]
    : ['pc', target.binding.accountId, target.binding.pcId, target.binding.sessionId])
}

const RECENT_PC_TURNS = 5

/** Keep the newest computer turns and any phone message the computer has not echoed yet. */
function mergePcTurns(server: WindowTranscript['turns'], local: WindowTranscript['turns']): WindowTranscript['turns'] {
  const pending = local.filter(turn => turn.pending === true)
  const seen = new Map<string, number>()
  for (const turn of server) if (turn.role === 'user') seen.set(turn.text, (seen.get(turn.text) ?? 0) + 1)
  const kept = pending.filter((turn) => {
    const left = seen.get(turn.text) ?? 0
    if (left <= 0) return true
    seen.set(turn.text, left - 1)
    return false
  })
  return [...server.slice(-Math.max(0, RECENT_PC_TURNS - kept.length)), ...kept]
}

function relayNeedsBootstrap(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message === 'PC_RELAY_BOOTSTRAP_REQUIRED' || (error as { code?: string }).code === 'PC_RELAY_BOOTSTRAP_REQUIRED'
}

/** One fresh bootstrap when the relay dropped its short lease, then a single retry. */
function resilientPcPort(port: PcWindowPort, deviceId: string, sessionId: string): PcWindowPort {
  const once = async <T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> => {
    try { return await run() }
    catch (error) {
      if (!relayNeedsBootstrap(error) || signal.aborted) throw error
      const boot = await port.bootstrap(deviceId, signal, sessionId)
      if (boot.binding.sourceDeviceId !== deviceId || boot.binding.sessionId !== sessionId) throw error
      return await run()
    }
  }
  return {
    bootstrap: (...args) => port.bootstrap(...args),
    access: (binding, signal) => once(signal, () => port.access(binding, signal)),
    submit: (command, signal) => once(signal, () => port.submit(command, signal)),
    sync: (binding, cursor, ids, signal) => once(signal, () => port.sync(binding, cursor, ids, signal)),
    transcript: (binding, signal) => once(signal, () => port.transcript(binding, signal)),
  }
}

function sameBinding(
  a: { readonly accountId: string; readonly sessionId: string },
  b: { readonly accountId: string; readonly sessionId: string },
): boolean {
  return a.accountId === b.accountId && a.sessionId === b.sessionId
}

/** Account changes clear visible data synchronously and discard every late response. */
export class MobileWorkspace {
  private accountId: string | null
  private abort = new AbortController()
  private generation = 0
  private directoryRequest = 0
  private selectionRequest = 0
  private disposed = false
  private foreground = true
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly polling = new Set<Conversation>()
  private readonly unsubscribeAccount: () => void
  private devices: MobileWorkspaceSnapshot['devices'] = []
  private directoryState: MobileWorkspaceSnapshot['directoryState']
  private error: MobileWorkspaceSnapshot['error'] = null
  private selected: Conversation | null = null
  private conversations = new Map<string, Conversation>()

  /** @param options - Authenticated adapters and account-owned durable PC storage. */
  constructor(private readonly options: MobileWorkspaceOptions, private readonly changed: () => void = () => {}) {
    if (!Number.isFinite(options.commandTtlMs) || options.commandTtlMs <= 0) throw new Error('MOBILE_COMMAND_TTL_INVALID')
    if (!Number.isFinite(options.foregroundRefreshMs) || options.foregroundRefreshMs <= 0
      || !Number.isFinite(options.foregroundRefreshWindowMs) || options.foregroundRefreshWindowMs < options.foregroundRefreshMs) {
      throw new Error('MOBILE_REFRESH_CONFIG_INVALID')
    }
    this.accountId = options.account()
    this.directoryState = options.directory === undefined ? 'unconfigured' : 'idle'
    this.unsubscribeAccount = options.subscribeAccount(() => {
      this.checkAccount()
      queueMicrotask(() => { if (!this.disposed) this.notify() })
    })
  }

  /** @returns A detached projection containing no account tokens or executable phone capability. */
  snapshot(): MobileWorkspaceSnapshot {
    this.checkAccount()
    const selected = this.selected
    const pc = selected?.pc?.snapshot()
    return structuredClone({
      accountId: this.accountId, directoryState: this.directoryState, devices: this.devices,
      target: selected?.target ?? null, conversations: [...this.conversations.values()].map(item => item.target),
      turns: pc?.access === 'unauthorized' ? [] : selected?.turns ?? [],
      admissions: pc?.records.map(item => ({ requestId: item.command.requestId, text: item.command.action.type === 'cancel' ? '' : item.command.action.text, state: item.state })) ?? selected?.admissions ?? [],
      status: pc?.access === 'offline' ? 'offline' : selected?.status ?? 'unavailable',
      pending: (selected?.pending ?? 0) > 0,
      error: this.accountId === null ? 'signed-out' : selected?.error ?? this.error,
      draft: selected?.draft ?? null,
    })
  }

  /** Refresh devices without making cloud agent availability depend on any PC. */
  async refreshDevices(): Promise<void> {
    const context = this.context()
    if (context === null || this.options.directory === undefined) return
    const request = ++this.directoryRequest
    this.directoryState = 'loading'
    this.notify()
    try {
      const devices = await this.options.directory.list(context.accountId, context.signal)
      if (!this.current(context.generation) || request !== this.directoryRequest) return
      if (devices.some(pc => pc.accountId !== context.accountId) || new Set(devices.map(pc => pc.pcId)).size !== devices.length) {
        throw new Error('MOBILE_DIRECTORY_ACCOUNT_MISMATCH')
      }
      this.devices = structuredClone(devices)
      this.directoryState = 'ready'
      if (this.error === 'directory-error') this.error = null
    } catch {
      if (!this.current(context.generation) || request !== this.directoryRequest) return
      this.directoryState = 'error'
      this.error = 'directory-error'
    }
    this.notify()
  }

  /**
   * Resume the newest ready account Session already stored by the agent port.
   * An empty list leaves the workspace without a selection. This does not call `open`.
   */
  async restoreAgent(): Promise<void> {
    const context = this.context()
    const list = this.options.agent?.list
    if (context === null || list === undefined) return
    const selection = ++this.selectionRequest
    try {
      const bindings = await list(context.accountId, context.signal)
      if (!this.current(context.generation) || selection !== this.selectionRequest) return
      if (bindings.some(item => item.accountId !== context.accountId)) throw new Error('MOBILE_AGENT_ACCOUNT_MISMATCH')
      const latest = bindings.at(-1)
      if (latest === undefined) return
      this.select({ kind: 'agent', binding: latest })
      await this.refreshConversation()
    } catch {
      if (this.current(context.generation) && selection === this.selectionRequest) { this.error = 'agent-unavailable'; this.notify() }
    }
  }

  /** Open an independent account agent Session; missing runtime never falls back to a raw LLM. */
  async openAgent(): Promise<void> {
    const context = this.context()
    if (context === null) return
    if (this.options.agent === undefined) { this.error = 'agent-unavailable'; this.notify(); return }
    const selection = ++this.selectionRequest
    try {
      const binding = await this.options.agent.open(context.accountId, this.options.deviceId, context.signal)
      if (!this.current(context.generation) || selection !== this.selectionRequest) return
      if (binding.accountId !== context.accountId) throw new Error('MOBILE_AGENT_ACCOUNT_MISMATCH')
      this.select({ kind: 'agent', binding })
      await this.refreshConversation()
    } catch {
      if (this.current(context.generation) && selection === this.selectionRequest) { this.error = 'agent-unavailable'; this.notify() }
    }
  }

  /**
   * Open the selected PC's authorized Session, preserving complete binding identity.
   * @param pcId - Device selected from this account's last successful directory.
   * @param sessionId - Optional existing Session on that PC, verified by its gateway.
   */
  async openPc(pcId: string, sessionId?: string): Promise<void> {
    const context = this.context()
    if (context === null || this.options.directory === undefined) return
    const pc = this.devices.find(item => item.pcId === pcId)
    if (pc === undefined || !pc.online) { this.error = 'pc-offline'; this.notify(); return }
    const selection = ++this.selectionRequest
    try {
      const port = await this.options.directory.connect(pc, context.signal)
      if (!this.current(context.generation) || selection !== this.selectionRequest) return
      const boot = await port.bootstrap(this.options.deviceId, context.signal, sessionId)
      if (!this.current(context.generation) || selection !== this.selectionRequest) return
      if (boot.binding.accountId !== context.accountId || boot.binding.pcId !== pcId
        || boot.binding.sourceDeviceId !== this.options.deviceId
        || (sessionId !== undefined && boot.binding.sessionId !== sessionId)) throw new Error('MOBILE_PC_BINDING_MISMATCH')
      const target: MobileConversationTarget = { kind: 'pc', binding: boot.binding, label: pc.label }
      const id = key(target)
      let conversation = this.conversations.get(id)
      if (conversation === undefined) {
        const transport = mutablePcPort(resilientPcPort(port, this.options.deviceId, boot.binding.sessionId))
        const controller = new PcWindowController({
          port: transport.port, store: this.options.pcStore, requestId: this.options.requestId, now: this.options.now,
        })
        await controller.connect(boot.binding)
        if (!this.current(context.generation) || selection !== this.selectionRequest) { controller.disconnect(); return }
        conversation = { ...this.make(target, transport.port, controller), replacePort: transport.replace }
        this.conversations.set(id, conversation)
      } else {
        conversation.readRequest += 1
        conversation.replacePort?.(resilientPcPort(port, this.options.deviceId, boot.binding.sessionId))
        conversation.connecting = conversation.pc?.connect(boot.binding) ?? Promise.resolve()
        await conversation.connecting
        if (!this.current(context.generation) || selection !== this.selectionRequest) return
      }
      this.selected = conversation
      conversation.observingSince = null
      this.clearTimer()
      this.error = null
      this.notify()
      await this.refreshConversation()
    } catch {
      if (this.current(context.generation) && selection === this.selectionRequest) { this.error = 'target-error'; this.notify() }
    }
  }

  /**
   * Restore an already open conversation without rebinding any queued command.
   * @param target - Target returned by this account's snapshot.
   */
  selectConversation(target: MobileConversationTarget): void {
    this.checkAccount()
    const conversation = this.conversations.get(key(target))
    if (conversation === undefined || target.binding.accountId !== this.accountId) return
    this.selectionRequest += 1
    this.selected = conversation
    conversation.observingSince = null
    this.clearTimer()
    this.error = null
    this.notify()
    void this.refreshConversation()
  }

  /** Reconcile the active Session's authoritative transcript and delivery receipts. */
  async refreshConversation(): Promise<void> {
    const context = this.context()
    const conversation = this.selected
    if (context === null || conversation === null) return
    await this.inspect(conversation, context.generation, context.signal)
  }

  /**
   * Queue original input on its captured target. Same-Session admissions are ordered; other Sessions remain independent.
   * @param text - User-entered text; generation detection creates a preparation card only.
   * @returns Whether input reached the durable PC outbox or the account agent admission attempt; false keeps the composer text.
   */
  async send(text: string): Promise<boolean> {
    const context = this.context()
    const conversation = this.selected
    if (context === null || conversation === null || text.trim().length === 0) return false
    const previous = conversation.draft
    conversation.draft = decideTrigger(text, {
      hasActiveTask: conversation.status === 'running',
      ...(previous?.kind !== 'trigger' ? {} : { previousRequest: { object: previous.object, prompt: previous.draft.originalText } }),
    })
    conversation.pending += 1
    conversation.error = null
    this.notify()
    let recorded = false
    const operation = conversation.tail.then(async () => {
      await conversation.connecting
      if (!this.current(context.generation)) return
      conversation.observeUntil = this.options.now() + this.options.foregroundRefreshWindowMs
      conversation.sawRunning = false
      conversation.observingSince = null
      this.notify()
      if (conversation.target.kind === 'pc' && conversation.pc !== undefined) {
        conversation.turns = mergePcTurns(conversation.turns.filter(turn => turn.pending !== true), [
          ...conversation.turns.filter(turn => turn.pending === true),
          { id: `local:${String(this.options.now())}:${String(conversation.turns.length)}`, role: 'user', text, at: this.options.now(), pending: true },
        ])
        this.notify()
        await conversation.pc.enqueue({ type: 'dispatch', text }, this.options.now() + this.options.commandTtlMs)
        recorded = true
        await conversation.pc.flush()
      } else if (conversation.target.kind === 'agent' && this.options.agent !== undefined) {
        const requestId = this.options.requestId()
        conversation.admissions.push({ requestId, text, state: 'delivering' })
        recorded = true
        this.notify()
        try {
          const receipt = await this.options.agent.submit(conversation.target.binding, { requestId, text }, context.signal)
          if (!this.current(context.generation)) return
          if (!sameBinding(receipt.binding, conversation.target.binding) || receipt.requestId !== requestId) throw new Error('MOBILE_AGENT_RECEIPT_MISMATCH')
          conversation.admissions = conversation.admissions.map(item => (
            item.requestId === requestId ? { ...item, state: receipt.state } : item
          ))
        } catch (error) {
          if (this.current(context.generation)) conversation.admissions = conversation.admissions.map(item => item.requestId === requestId ? { ...item, state: 'uncertain' } : item)
          throw error
        }
      }
      if (this.current(context.generation)) await this.inspect(conversation, context.generation, context.signal)
    })
    conversation.tail = operation.catch(() => { if (this.current(context.generation)) conversation.error = 'send-error' }).finally(() => {
      conversation.pending -= 1
      if (this.current(context.generation)) this.notify()
    })
    await conversation.tail
    return recorded
  }

  /**
   * Pause automatic reads when the native surface leaves the foreground.
   * @param foreground - Visibility from the native lifecycle port.
   */
  setForeground(foreground: boolean): void {
    this.foreground = foreground
    if (this.selected !== null) this.selected.observingSince = null
    this.clearTimer()
    if (foreground) void this.refreshConversation()
  }

  /** Hide all account data and abort transport; admitted remote tasks remain owned by their Sessions. */
  dispose(): void {
    this.unsubscribeAccount()
    this.reset(null)
    this.disposed = true
  }


  private notify(): void {
    this.changed()
    this.scheduleRefresh()
  }

  private clearTimer(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }

  private scheduleRefresh(): void {
    this.clearTimer()
    const selected = this.selected
    if (selected === null) return
    const watchingAdmission = selected.observeUntil !== null && this.options.now() < selected.observeUntil
    const liveComputer = selected.target.kind === 'pc' && this.computerOnline(selected.target.binding.pcId)
    const followOutput = selected.status === 'running' || watchingAdmission
    if (!followOutput && !liveComputer) { selected.observingSince = null; return }
    if (this.disposed || !this.foreground || this.polling.has(selected)) return
    if (!liveComputer) {
      selected.observingSince ??= this.options.now()
      if (this.options.now() - selected.observingSince >= this.options.foregroundRefreshWindowMs) return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      const conversation = this.selected
      const context = this.context()
      if (conversation === null || context === null) return
      this.polling.add(conversation)
      void this.inspect(conversation, context.generation, context.signal).finally(() => {
        this.polling.delete(conversation)
        if (this.selected === conversation) this.scheduleRefresh()
      })
    }, this.options.foregroundRefreshMs)
  }

  private computerOnline(pcId: string): boolean {
    return this.devices.some(device => device.pcId === pcId && device.online)
  }

  private context(): { accountId: string; generation: number; signal: AbortSignal } | null {
    this.checkAccount()
    return this.accountId === null || this.disposed
      ? null : { accountId: this.accountId, generation: this.generation, signal: this.abort.signal }
  }

  private current(generation: number): boolean {
    this.checkAccount()
    return !this.disposed && generation === this.generation
  }

  private checkAccount(): void {
    if (this.disposed) return
    const accountId = this.options.account()
    if (accountId !== this.accountId) this.reset(accountId)
  }

  private reset(accountId: string | null): void {
    this.clearTimer()
    this.generation += 1
    this.selectionRequest += 1
    this.abort.abort()
    this.abort = new AbortController()
    for (const conversation of this.conversations.values()) conversation.pc?.disconnect()
    this.conversations.clear()
    this.selected = null
    this.devices = []
    this.accountId = accountId
    this.directoryState = this.options.directory === undefined ? 'unconfigured' : 'idle'
    this.error = null
  }

  private select(target: MobileConversationTarget): void {
    let conversation = this.conversations.get(key(target))
    if (conversation === undefined) { conversation = this.make(target); this.conversations.set(key(target), conversation) }
    this.selected = conversation
    conversation.observingSince = null
    this.clearTimer()
    this.error = null
    this.notify()
  }

  private make(target: MobileConversationTarget, port?: PcWindowPort, pc?: PcWindowController): Conversation {
    return { target, ...(port === undefined ? {} : { port }), ...(pc === undefined ? {} : { pc }), turns: [], admissions: [], status: 'unavailable', pending: 0, tail: Promise.resolve(), connecting: Promise.resolve(), draft: null, error: null, readRequest: 0, observeUntil: null, observingSince: null, sawRunning: false }
  }

  private async inspect(conversation: Conversation, generation: number, signal: AbortSignal): Promise<void> {
    const readRequest = ++conversation.readRequest
    const current = (): boolean => this.current(generation) && readRequest === conversation.readRequest
    try {
      const target = conversation.target
      if (target.kind === 'pc' && conversation.pc !== undefined && conversation.port !== undefined) {
        const transcriptPromise = conversation.port.transcript(target.binding, signal)
        try { await conversation.pc.refresh() }
        catch { /* A receipt-cursor failure must not hide the computer's messages. */ }
        if (!current()) { void transcriptPromise.catch(() => undefined); return }
        const snapshot = conversation.pc.snapshot()
        if (snapshot.access === 'unauthorized') {
          void transcriptPromise.catch(() => undefined)
          conversation.turns = []
          conversation.status = 'unavailable'
          this.notify()
          return
        }
        if (snapshot.access === 'offline') {
          void transcriptPromise.catch(() => undefined)
          conversation.status = 'offline'
          this.notify()
          return
        }
        if (snapshot.access !== 'online' && !this.computerOnline(target.binding.pcId)) {
          void transcriptPromise.catch(() => undefined)
          conversation.status = 'unavailable'
          this.notify()
          return
        }
        const transcript = await transcriptPromise
        if (!current()) return
        if (!sameBinding(transcript.binding, target.binding) || transcript.binding.pcId !== target.binding.pcId
          || transcript.binding.sourceDeviceId !== target.binding.sourceDeviceId) throw new Error('MOBILE_TRANSCRIPT_BINDING_MISMATCH')
        conversation.turns = mergePcTurns(transcript.turns, conversation.turns)
        conversation.status = transcript.status
      } else if (target.kind === 'agent' && this.options.agent !== undefined) {
        const transcript = await this.options.agent.inspect(target.binding, signal)
        if (!current()) return
        if (!sameBinding(transcript.binding, target.binding)) throw new Error('MOBILE_TRANSCRIPT_BINDING_MISMATCH')
        conversation.turns = transcript.turns
        conversation.status = transcript.status
      }
      if (conversation.status === 'running') conversation.sawRunning = true
      else if (conversation.status === 'idle' && conversation.sawRunning) conversation.observeUntil = null
      conversation.error = null
    } catch {
      if (!current()) return
      const target = conversation.target
      if (target.kind === 'pc' && this.computerOnline(target.binding.pcId)) {
        if (conversation.turns.length === 0) conversation.status = 'unavailable'
      } else {
        conversation.status = 'unavailable'
        if (conversation.pc?.snapshot().access === 'unauthorized') conversation.turns = []
        conversation.error = 'target-error'
      }
    }
    this.notify()
  }
}


/** Switch an authorized transport while the same controller preserves the durable outbox. */
function mutablePcPort(initial: PcWindowPort): { port: PcWindowPort; replace: (port: PcWindowPort) => void } {
  let current = initial
  return {
    replace: (port) => { current = port },
    port: {
      bootstrap: (...args) => current.bootstrap(...args),
      access: (...args) => current.access(...args),
      submit: (...args) => current.submit(...args),
      sync: (...args) => current.sync(...args),
      transcript: (...args) => current.transcript(...args),
    },
  }
}
