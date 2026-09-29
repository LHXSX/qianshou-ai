/** Serialized, owner-only coordinator state; tokens are stored as digests only. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DeviceInfo, RemoteJob } from './protocol.ts'

/** Durable public device metadata paired with a credential digest, never the credential itself. */
export interface StoredDevice { info: DeviceInfo; tokenHash: string }
/** Versioned private device identities and retained task receipts. */
export interface CoordinatorState { version: 1; devices: StoredDevice[]; jobs: RemoteJob[] }

/** Serialize snapshots to an owner-controlled file through atomic replacement. */
export class CoordinatorStorage {
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly path: string) {}

  /**
   * Read private state, marking loaded devices disconnected until they authenticate.
   * @returns Parsed state, or empty version-one state when the file does not exist.
   * @throws On I/O failure or invalid state version, collection shape or credential digest.
   */
  async load(): Promise<CoordinatorState> {
    let raw: string
    try { raw = await readFile(this.path, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, devices: [], jobs: [] }; throw error }
    const state = JSON.parse(raw) as CoordinatorState
    if (state.version !== 1 || !Array.isArray(state.devices) || !Array.isArray(state.jobs)) throw new Error('INVALID_DEVICE_STATE')
    for (const device of state.devices) {
      if (typeof device.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(device.tokenHash)) throw new Error('INVALID_DEVICE_STATE')
      device.info.connected = false
    }
    return state
  }

  /**
   * Commit a snapshot in call order without placing private values in application logs.
   * @param state - Snapshot serialized synchronously before the queued write.
   * @returns Completion after atomic replacement; rejects on write or rename failure.
   */
  save(state: CoordinatorState): Promise<void> {
    const data = JSON.stringify(state)
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = this.path + '.tmp'
      await writeFile(temporary, data, { mode: 0o600 })
      await rename(temporary, this.path)
    })
    return this.writes
  }
}
