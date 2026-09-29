/** One local SKILL.md import, held by the Host between review and installation. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

export interface SkillImportInspectionView {
  inspectionId: string
  name: string
  description: string
  sha256: string
  bytes: number
  targetPath: string
  expiresAt: number
  modelInvocable: boolean
  userInvocable: boolean
}

export interface SkillImportView {
  status: 'idle' | 'reading' | 'inspecting' | 'ready' | 'installing' | 'verifying' | 'unconfirmed' | 'written' | 'error'
  fileName: string
  content: string | null
  inspection: SkillImportInspectionView | null
  writtenPath: string | null
  error: 'invalidFile' | 'tooLarge' | 'readFailed' | 'invalid' | 'conflict' | 'different' | 'expired' | 'unsafePath' | 'unavailable' | null
}

type RemoteValue<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message: string } }
interface SkillImportRemote {
  inspect(content: string): Promise<RemoteValue<SkillImportInspectionView>>
  install(inspectionId: string): Promise<RemoteValue<{ state: 'written'; name: string; sha256: string; path: string; bytes: number }>>
  verify(name: string, sha256: string): Promise<RemoteValue<{ state: 'matched' | 'different' | 'missing' }>>
}

const MAX_BYTES = 256 * 1024
const EMPTY: SkillImportView = { status: 'idle', fileName: '', content: null, inspection: null, writtenPath: null, error: null }

function remoteError(error: unknown): NonNullable<SkillImportView['error']> {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code === 'skill-import/invalid') return 'invalid'
  if (code === 'skill-import/conflict') return 'conflict'
  if (code === 'skill-import/expired') return 'expired'
  if (code === 'skill-import/unsafe-path') return 'unsafePath'
  return 'unavailable'
}

/** Only reviewed bytes may be committed; the client never chooses a destination path. */
export class SkillImportController {
  readonly store = createSnapshotStore<SkillImportView>(EMPTY)
  private generation = 0
  private disposed = false
  constructor(private readonly ctx: Context) {}

  dispose(): void { this.disposed = true; this.generation += 1 }
  dismiss(): void {
    if (this.disposed || ['installing', 'verifying'].includes(this.store.getSnapshot().status)) return
    this.generation += 1
    this.store.set(EMPTY)
  }

  /** Validate a local Markdown file's bytes before submitting its text for Host inspection. */
  async inspectFile(file: File): Promise<void> {
    if (this.disposed) return
    if (['installing', 'verifying', 'unconfirmed'].includes(this.store.getSnapshot().status)) return
    const generation = ++this.generation
    const fileName = file.name
    this.store.set({ status: 'reading', fileName, content: null, inspection: null, writtenPath: null, error: null })
    if (!fileName.toLocaleLowerCase().endsWith('.md')) {
      this.fail(generation, fileName, 'invalidFile'); return
    }
    if (file.size === 0 || file.size > MAX_BYTES) {
      this.fail(generation, fileName, 'tooLarge'); return
    }
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
    } catch {
      this.fail(generation, fileName, 'readFailed'); return
    }
    if (!this.current(generation)) return
    if (new TextEncoder().encode(content).byteLength !== file.size) {
      this.fail(generation, fileName, 'readFailed'); return
    }
    this.store.set({ status: 'inspecting', fileName, content: null, inspection: null, writtenPath: null, error: null })
    try {
      const remote = (this.ctx.remote as unknown as { qianshouSkillImport: SkillImportRemote }).qianshouSkillImport
      const result = await remote.inspect(content)
      if (!this.current(generation)) return
      if (!result.ok) { this.fail(generation, fileName, remoteError(result.error)); return }
      this.store.set({ status: 'ready', fileName, content, inspection: result.value, writtenPath: null, error: null })
    } catch (error) { this.fail(generation, fileName, remoteError(error)) }
  }

  /** Commit the exact Host-held inspection after the person reviews its name and destination. */
  async install(): Promise<void> {
    if (this.disposed) return
    const current = this.store.getSnapshot()
    if (current.status !== 'ready' || current.inspection === null) return
    const generation = ++this.generation
    this.store.set({ ...current, status: 'installing', error: null })
    try {
      const remote = (this.ctx.remote as unknown as { qianshouSkillImport: SkillImportRemote }).qianshouSkillImport
      const result = await remote.install(current.inspection.inspectionId)
      if (!this.current(generation)) return
      if (!result.ok) {
        const error = remoteError(result.error)
        if (error === 'unavailable') await this.verifyAfterUncertainWrite(current, generation)
        else this.fail(generation, current.fileName, error)
        return
      }
      if (result.value.state !== 'written' || result.value.name !== current.inspection.name
        || result.value.sha256 !== current.inspection.sha256 || result.value.bytes !== current.inspection.bytes
        || result.value.path !== current.inspection.targetPath) {
        await this.verifyAfterUncertainWrite(current, generation)
        return
      }
      this.store.set({ ...current, status: 'written', content: null, writtenPath: result.value.path, error: null })
    } catch { await this.verifyAfterUncertainWrite(current, generation) }
  }

  /** Re-read the controlled destination after a lost install reply; never retry the write blindly. */
  async checkWrite(): Promise<void> {
    const current = this.store.getSnapshot()
    if (this.disposed || current.status !== 'unconfirmed' || current.inspection === null) return
    const generation = ++this.generation
    await this.verifyAfterUncertainWrite(current, generation)
  }

  private async verifyAfterUncertainWrite(current: SkillImportView, generation: number): Promise<void> {
    if (!this.current(generation) || current.inspection === null) return
    this.store.set({ ...current, status: 'verifying', content: null, error: null })
    try {
      const remote = (this.ctx.remote as unknown as { qianshouSkillImport: SkillImportRemote }).qianshouSkillImport
      const result = await remote.verify(current.inspection.name, current.inspection.sha256)
      if (!this.current(generation)) return
      if (result.ok && result.value.state === 'matched') {
        this.store.set({ ...current, status: 'written', content: null,
          writtenPath: current.inspection.targetPath, error: null })
      } else if (result.ok && result.value.state === 'different') {
        this.fail(generation, current.fileName, 'different')
      } else {
        this.store.set({ ...current, status: 'unconfirmed', content: null, error: null })
      }
    } catch {
      if (this.current(generation)) this.store.set({ ...current, status: 'unconfirmed', content: null, error: null })
    }
  }

  private current(generation: number): boolean { return !this.disposed && this.generation === generation }
  private fail(generation: number, fileName: string, error: NonNullable<SkillImportView['error']>): void {
    if (this.current(generation)) this.store.set({ status: 'error', fileName, content: null, inspection: null, writtenPath: null, error })
  }
}
