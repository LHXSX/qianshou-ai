/** Atomic private local preferences; Electron encrypts credentials before this storage boundary. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RemoteJob, RemoteWorkspace } from '@deepseek-ai/dsh-host-remote-devices/protocol'

export interface SavedConnection { encryptedCredential: string; jobs: RemoteJob[] }
export interface LocalPreferences {
  version: 1; endpoint: string; name: string; workspaces: RemoteWorkspace[]
  connections: Record<string, SavedConnection>
}
export class LocalStore {
  private pending = Promise.resolve()
  constructor(private readonly path: string) {}
  /** Read owner-local state; invalid version and malformed files fail visibly. */
  async read(fallback: LocalPreferences): Promise<LocalPreferences> {
    let raw: string
    try { raw = await readFile(this.path, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error }
    const value = JSON.parse(raw) as LocalPreferences
    if (value.version !== 1 || !Array.isArray(value.workspaces) || !value.connections || typeof value.endpoint !== 'string') throw new Error('INVALID_LOCAL_STATE')
    return value
  }
  /** Serialize writes so a later receipt cannot be replaced by an older snapshot. */
  save(value: LocalPreferences): Promise<void> {
    const serialized = JSON.stringify(value)
    this.pending = this.pending.catch(() => { /* A later user action retries an earlier failed private-state write. */ }).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await writeFile(this.path + '.tmp', serialized, { mode: 0o600 })
      await rename(this.path + '.tmp', this.path)
    })
    return this.pending
  }
  /** Await all accepted preference and credential writes before an application update exits. */
  flush(): Promise<void> { return this.pending }
}
