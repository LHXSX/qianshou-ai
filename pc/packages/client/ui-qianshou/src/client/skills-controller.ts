import type { SessionId, SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SkillSeatState } from './SkillSeat.tsx'

interface SkillsRemote {
  list(request: { sessionId: SessionId }, signal?: AbortSignal): Promise<
    { ok: true, value: { skills: readonly SkillEntry[] } } | { ok: false, error: unknown }
  >
}

interface SessionSkills {
  store: ReturnType<typeof createSnapshotStore<SkillSeatState>>
  generation: number
  request: Promise<void> | null
  loaded: boolean
}

/** The composer list uses the real Session skill catalog, not installed node declarations. */
export class SkillsController {
  private readonly sessions = new Map<SessionId, SessionSkills>()
  private disposed = false

  constructor(private readonly remote: SkillsRemote) {}

  storeFor(sessionId: SessionId): SessionSkills['store'] {
    let entry = this.sessions.get(sessionId)
    if (entry === undefined) {
      entry = {
        store: createSnapshotStore<SkillSeatState>({ skills: [], loading: false, error: false }),
        generation: 0,
        request: null,
        loaded: false,
      }
      this.sessions.set(sessionId, entry)
    }
    return entry.store
  }

  load(sessionId: SessionId): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const store = this.storeFor(sessionId)
    const entry = this.sessions.get(sessionId)!
    if (entry.request !== null) return entry.request
    if (entry.loaded) return Promise.resolve()
    const generation = ++entry.generation
    store.set({ ...store.getSnapshot(), loading: true, error: false })
    const request = (async () => {
      try {
        const result = await this.remote.list({ sessionId })
        if (!result.ok) throw new Error('skills-unavailable')
        if (!this.disposed && generation === entry.generation) {
          entry.loaded = true
          store.set({ skills: result.value.skills, loading: false, error: false })
        }
      } catch {
        if (!this.disposed && generation === entry.generation) {
          entry.loaded = true
          store.set({ ...store.getSnapshot(), loading: false, error: true })
        }
      } finally {
        if (generation === entry.generation) entry.request = null
      }
    })()
    entry.request = request
    return request
  }

  reload(sessionId: SessionId): Promise<void> {
    this.invalidate(sessionId)
    return this.load(sessionId)
  }

  /** Re-read every mounted Session after the Host reports a skill file change. */
  async refreshKnown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(sessionId => this.reload(sessionId)))
  }

  invalidate(sessionId?: SessionId): void {
    const entries = sessionId === undefined ? this.sessions.values() : [this.sessions.get(sessionId)]
    for (const entry of entries) {
      if (entry === undefined) continue
      entry.generation++
      entry.request = null
      entry.loaded = false
      entry.store.set({ ...entry.store.getSnapshot(), loading: true, error: false })
    }
  }

  dispose(): void {
    this.disposed = true
    this.invalidate()
    this.sessions.clear()
  }
}
