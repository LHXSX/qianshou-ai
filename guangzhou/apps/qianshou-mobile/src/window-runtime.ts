/** Phone runtime: owner-cookie bootstrap plus PC-window command delivery. */

import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { randomId } from './id.ts'
import {
  IndexedDbWindowJournalStore,
  PcWindowController,
  PcWindowHttpPort,
  type PcWindowSnapshot,
  type WindowJournal,
  type WindowJournalStore,
} from '@deepseek-ai/dsh-client-pc-window-bridge'

/** localStorage key for the stable phone device id. */
const DEVICE_KEY = 'qianshou.phone.source-device-id'
/** IndexedDB name isolated from other features on this origin. */
const JOURNAL_DB = 'qianshou.pc-window.v1'
/** Dispatch lifetime: long enough to survive a queued PC turn, never unbounded. */
const COMMAND_TTL_MS = 10 * 60 * 1000

/** Injected adapters so Node tests do not need IndexedDB. */
export interface PhoneWindowOptions {
  readonly port?: PcWindowHttpPort
  readonly store?: WindowJournalStore
  readonly deviceId?: string
  readonly sessionId?: string
  readonly now?: () => number
  readonly requestId?: () => SessionRequestId
}

/** Observable phone-window state for the product UI. */
export interface PhoneWindowSnapshot extends PcWindowSnapshot {
  readonly connecting: boolean
}

/** In-memory outbox used when IndexedDB is unavailable or when tests inject storage. */
export class MemoryWindowJournalStore implements WindowJournalStore {
  private readonly rows = new Map<string, WindowJournal>()

  load(binding: Parameters<WindowJournalStore['load']>[0]): Promise<unknown> {
    return Promise.resolve(structuredClone(this.rows.get(originKey(binding)) ?? null))
  }

  save(journal: WindowJournal, expectedRevision: number): Promise<void> {
    if ((this.rows.get(originKey(journal.binding))?.revision ?? 0) !== expectedRevision) {
      return Promise.reject(new Error('PC_WINDOW_STALE_LOCAL_REVISION'))
    }
    this.rows.set(originKey(journal.binding), structuredClone(journal))
    return Promise.resolve()
  }

  remove(binding: Parameters<WindowJournalStore['remove']>[0]): Promise<void> {
    this.rows.delete(originKey(binding))
    return Promise.resolve()
  }
}

/** Phone-owned window onto one PC Session. */
export class PhoneWindowRuntime {
  private connecting = false
  private snapshotCache: PhoneWindowSnapshot | null = null
  private readonly listeners = new Set<() => void>()
  private readonly controller: PcWindowController
  private readonly port: PcWindowHttpPort
  private readonly deviceId: string
  private readonly sessionId: string | undefined
  private readonly now: () => number

  private constructor(options: PhoneWindowOptions, store: WindowJournalStore) {
    this.port = options.port ?? new PcWindowHttpPort({ baseUrl: '' })
    this.deviceId = options.deviceId ?? readDeviceId()
    this.sessionId = options.sessionId
    this.now = options.now ?? (() => Date.now())
    this.controller = new PcWindowController({
      port: this.port,
      store,
      requestId: options.requestId ?? mintRequestId,
      now: this.now,
    })
  }

  /**
   * Open the local journal and connect through owner-authenticated bootstrap.
   * @param options - Optional injected port, store and identities.
   * @returns A runtime whose snapshot reflects the host access verdict.
   */
  static async open(options: PhoneWindowOptions = {}): Promise<PhoneWindowRuntime> {
    const store = options.store ?? await openJournalStore()
    const runtime = new PhoneWindowRuntime(options, store)
    await runtime.connect()
    return runtime
  }

  /** Subscribe to snapshot changes; returns the disposer. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Detached projection of origin, delivery records and access. */
  snapshot = (): PhoneWindowSnapshot => {
    this.snapshotCache ??= { ...this.controller.snapshot(), connecting: this.connecting }
    return this.snapshotCache
  }

  /**
   * Drop the cached projection and notify subscribers.
   *
   * The controller settles a dispatch asynchronously (`enqueue` resolves on the local
   * journal commit, while admission and its receipt land later), and it exposes no
   * change event of its own. Without this call the runtime's cached snapshot keeps
   * reporting `queued`, so the product UI can never show 「已接收」/「未确认」.
   * This re-reads local state only: no network request, no journal write.
   */
  refresh(): void {
    this.emit()
  }

  /** Re-run owner-authenticated bootstrap and resume the journal. */
  async connect(): Promise<void> {
    this.connecting = true
    this.emit()
    try {
      const result = await this.port.bootstrap(this.deviceId, new AbortController().signal, this.sessionId)
      await this.controller.connect(result.binding)
    } finally {
      this.connecting = false
      this.emit()
    }
  }

  /**
   * Persist a dispatch on the phone, then admit it to the bound PC Session.
   * @param text - User input; empty text is ignored.
   * @returns The local request id after the journal commit, or null when ignored.
   */
  async enqueue(text: string): Promise<SessionRequestId | null> {
    const content = text.trim()
    if (content.length === 0) return null
    const requestId = await this.controller.enqueue({ type: 'dispatch', text: content }, this.now() + COMMAND_TTL_MS)
    this.emit()
    return requestId
  }

  private emit(): void {
    this.snapshotCache = null
    for (const listener of this.listeners) listener()
  }
}

function originKey(binding: { accountId: string; pcId: string; sessionId: string; sourceDeviceId: string }): string {
  return `${binding.accountId}\0${binding.pcId}\0${binding.sessionId}\0${binding.sourceDeviceId}`
}

function mintRequestId(): SessionRequestId {
  // 经本地生成器：手机端跑在明文 HTTP 页面上，`crypto.randomUUID` 在那里不可用。
  return randomId() as SessionRequestId
}

/**
 * 这台设备的稳定标识。
 *
 * 配对时要用它：绑定里的 `sourceDeviceId` 就是它，宿主据此区分「是哪台手机」。
 * 导出而不是留在模块内，是因为配对流程在另一个模块里。
 */
export function readDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY)
    if (existing !== null && existing.length > 0) return existing
    const minted = randomId()
    localStorage.setItem(DEVICE_KEY, minted)
    return minted
  } catch {
    return randomId()
  }
}

async function openJournalStore(): Promise<WindowJournalStore> {
  try {
    if (typeof indexedDB === 'undefined') return new MemoryWindowJournalStore()
    return await IndexedDbWindowJournalStore.open(indexedDB, JOURNAL_DB)
  } catch {
    return new MemoryWindowJournalStore()
  }
}
