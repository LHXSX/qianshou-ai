/** Local device behavior controlled by the owner, never by a dispatched task. */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { App, PowerSaveBlocker } from 'electron'

/** State returned to the owned desktop document. */
export interface DevicePreferencesState {
  readonly launchAtLogin: boolean
  readonly launchAtLoginAvailable: boolean
  readonly keepAwake: boolean
  readonly automaticUpdates: boolean
}

type DevicePreferenceName = 'launchAtLogin' | 'keepAwake' | 'automaticUpdates'

/** The display and login lock remain under the operating system's control. */
export class QianshouDevicePreferences {
  private keepAwake = true
  private automaticUpdates = true
  private blockerId: number | undefined
  private operation = Promise.resolve()
  private readonly file: string

  constructor(private readonly app: Pick<App, 'isPackaged' | 'getPath' | 'getLoginItemSettings' | 'setLoginItemSettings'>,
    private readonly blocker: Pick<PowerSaveBlocker, 'start' | 'stop'>,
    private readonly platform: NodeJS.Platform = process.platform) {
    this.file = join(app.getPath('userData'), 'qianshou-device-preferences.json')
  }

  /** Load the owner's saved sleep preference, then request a process-owned blocker. */
  async initialize(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid preferences')
      if ('keepAwake' in value && typeof value.keepAwake === 'boolean') this.keepAwake = value.keepAwake
      if ('automaticUpdates' in value) {
        if (typeof value.automaticUpdates !== 'boolean') throw new Error('invalid automatic update preference')
        this.automaticUpdates = value.automaticUpdates
      }
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') {
        this.automaticUpdates = false
        console.warn('Qianshou device preferences unavailable; automatic downloads are disabled')
      }
    }
    this.syncBlocker()
  }

  /** Read the OS registration instead of trusting a cached switch value. */
  status(): DevicePreferencesState {
    const available = this.app.isPackaged && (this.platform === 'darwin' || this.platform === 'win32')
    return {
      launchAtLogin: available ? this.app.getLoginItemSettings().openAtLogin : false,
      launchAtLoginAvailable: available,
      keepAwake: this.keepAwake,
      automaticUpdates: this.automaticUpdates,
    }
  }

  /** Serialize updates so rapid UI clicks cannot overwrite a newer choice. */
  set(name: DevicePreferenceName, enabled: boolean): Promise<DevicePreferencesState> {
    const next = this.operation.then(async () => {
      if (name === 'launchAtLogin') {
        if (!this.status().launchAtLoginAvailable) throw new Error('Launch at login requires an installed Qianshou application')
        this.app.setLoginItemSettings({ openAtLogin: enabled })
        if (this.app.getLoginItemSettings().openAtLogin !== enabled) {
          throw new Error('The operating system did not apply launch at login')
        }
      } else {
        const previous = this.keepAwake; const previousAutomatic = this.automaticUpdates
        if (name === 'keepAwake') this.keepAwake = enabled
        else this.automaticUpdates = enabled
        try {
          this.syncBlocker()
          await mkdir(dirname(this.file), { recursive: true })
          const temporary = `${this.file}.${randomUUID()}.tmp`
          try {
            await writeFile(temporary, `${JSON.stringify({ version: 1, keepAwake: this.keepAwake, automaticUpdates: this.automaticUpdates })}\n`, { mode: 0o600 })
            await rename(temporary, this.file)
          } catch (error) {
            await rm(temporary, { force: true })
            throw error
          }
        } catch (error) {
          this.keepAwake = previous; this.automaticUpdates = previousAutomatic
          this.syncBlocker()
          throw error
        }
      }
      return this.status()
    })
    this.operation = next.then(() => {}, () => {})
    return next
  }

  /** Release the blocker when Electron exits; a crash also releases its OS assertion. */
  dispose(): void {
    if (this.blockerId !== undefined) this.blocker.stop(this.blockerId)
    this.blockerId = undefined
  }

  private syncBlocker(): void {
    if (this.keepAwake && this.blockerId === undefined) {
      // Keeps work alive while allowing the display to sleep and the OS to lock.
      this.blockerId = this.blocker.start('prevent-app-suspension')
    } else if (!this.keepAwake && this.blockerId !== undefined) {
      this.blocker.stop(this.blockerId)
      this.blockerId = undefined
    }
  }
}
