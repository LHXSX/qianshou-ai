/** Session-addressed skill discovery for the Qianshou market. */
import type { SessionId, SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The market must not present a capability declaration as an available skill. */
export interface SessionSkillsView {
  readonly sessionId: SessionId | null
  readonly skills: readonly SkillEntry[]
  readonly status: 'no-session' | 'loading' | 'ready' | 'error'
}

interface SkillsRemote {
  list(request: { sessionId: SessionId }, signal?: AbortSignal): Promise<
    { ok: true, value: { skills: readonly SkillEntry[] } } | { ok: false, error: unknown }
  >
}

/** Read only the human-invocable skill catalog of the selected Session. */
export class SessionSkillsController {
  readonly store = createSnapshotStore<SessionSkillsView>({
    sessionId: null, skills: [], status: 'no-session',
  })
  private generation = 0
  private abort: AbortController | null = null
  private pending: Promise<void> | null = null
  private disposed = false

  /** @param remote - The Host's `skills/list` Remote for this Client generation. */
  constructor(private readonly remote: SkillsRemote) {}

  /**
   * Select the Session whose invocable skills the market displays.
   * @param sessionId - Current main-view Session, or null when no Session is open.
   * @returns The current read, if a Session is selected.
   */
  select(sessionId: SessionId | null): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.store.getSnapshot().sessionId === sessionId) return this.pending ?? Promise.resolve()
    this.cancel()
    this.store.set({ sessionId, skills: [], status: sessionId === null ? 'no-session' : 'loading' })
    return sessionId === null ? Promise.resolve() : this.read(sessionId)
  }

  /**
   * Re-read the selected Session after a skill file or composition may have changed.
   * @returns The new read, or a completed promise when no Session is selected.
   */
  reload(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const sessionId = this.store.getSnapshot().sessionId
    if (sessionId === null) return Promise.resolve()
    this.cancel()
    this.store.set({ sessionId, skills: [], status: 'loading' })
    return this.read(sessionId)
  }

  /** Stop reads and prevent late responses from publishing. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
  }

  private cancel(): void {
    this.generation += 1
    this.abort?.abort()
    this.abort = null
    this.pending = null
  }

  private read(sessionId: SessionId): Promise<void> {
    const generation = ++this.generation
    const abort = new AbortController()
    this.abort = abort
    const pending = (async () => {
      try {
        const result = await this.remote.list({ sessionId }, abort.signal)
        if (this.disposed || generation !== this.generation) return
        if (!result.ok) throw new Error('skills/list failed')
        this.store.set({ sessionId, skills: result.value.skills, status: 'ready' })
      } catch {
        if (!this.disposed && generation === this.generation) {
          this.store.set({ sessionId, skills: [], status: 'error' })
        }
      } finally {
        if (generation === this.generation) {
          this.abort = null
          this.pending = null
        }
      }
    })()
    this.pending = pending
    return pending
  }
}
