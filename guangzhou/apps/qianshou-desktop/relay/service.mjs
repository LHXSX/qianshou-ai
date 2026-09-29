/** Desktop relay capability: registrations are encrypted and each app launch starts disabled. */
import { mkdir } from 'node:fs/promises'
import { readEnrollment, verifyResources } from './config.mjs'
import { enrollmentStore } from './store.mjs'
import { startRelayProcess } from './process.mjs'

const publicErrors = new Set(['INVALID_ENROLLMENT', 'INVALID_RELAY_RESOURCES', 'SECURE_STORAGE_UNAVAILABLE', 'REGISTRATION_UNREADABLE', 'RELAY_STOP_FAILED'])
const errorCode = error => publicErrors.has(error?.message) ? error.message : 'RELAY_UNAVAILABLE'

/** Own one registration and one explicitly enabled connection without touching backend settings. */
export class RelayService {
  constructor({ directory, resourcesDirectory, backendPort, secureStorage, start = startRelayProcess }) {
    this.directory = directory
    this.resourcesDirectory = resourcesDirectory
    this.backendPort = backendPort
    this.start = start
    this.store = enrollmentStore(directory, secureStorage)
    this.error = null
    this.closed = false
    this.driver = undefined
    this.queue = this.store.load().then(value => { this.enrollment = value }, error => { this.error = errorCode(error) })
  }
  serialize(action) {
    const result = this.queue.then(action)
    this.queue = result.catch(() => { /* The caller receives the failure; subsequent actions still settle. */ })
    return result
  }
  async status() {
    await this.queue
    const driver = this.driver
    let phase = driver ? await driver.status() : this.enrollment ? 'disabled' : 'unconfigured'
    if (driver !== this.driver || this.closed) phase = this.enrollment ? 'disabled' : 'unconfigured'
    if (this.error) phase = 'error'
    return { configured: Boolean(this.enrollment), enabled: Boolean(this.driver), phase,
      endpoint: this.enrollment?.endpoint ?? null, error: this.error ?? (phase === 'error' ? 'RELAY_UNAVAILABLE' : null) }
  }
  async importFile(filename) {
    await this.serialize(async () => {
      if (this.closed) throw new Error('RELAY_UNAVAILABLE')
      if (this.driver) throw new Error('RELAY_DISABLE_BEFORE_IMPORT')
      try {
        const enrollment = await readEnrollment(filename)
        await this.store.save(enrollment)
        this.enrollment = enrollment
        this.error = null
      } catch (error) { this.error = errorCode(error); throw new Error(this.error) }
    })
    return this.status()
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('INVALID_RELAY_ACTION')
    await this.serialize(async () => {
      if (this.closed) throw new Error('RELAY_UNAVAILABLE')
      try {
        if (!enabled) {
          await this.driver?.stop()
          this.driver = undefined
        } else if (!this.driver) {
          if (!this.enrollment) throw new Error('INVALID_ENROLLMENT')
          const resources = await verifyResources(this.resourcesDirectory)
          await mkdir(this.directory, { recursive: true, mode: 0o700 })
          this.driver = await this.start({ enrollment: this.enrollment, resources, backendPort: this.backendPort, directory: this.directory })
        }
        this.error = null
      } catch (error) { this.error = errorCode(error); throw new Error(this.error) }
    })
    return this.status()
  }
  close() {
    this.closed = true
    return this.serialize(async () => {
      await this.driver?.stop()
      this.driver = undefined
    })
  }
}
