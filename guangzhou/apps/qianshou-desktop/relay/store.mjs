/** Desktop-only encrypted registration storage; plaintext never reaches renderer IPC. */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { parseEnrollment } from './config.mjs'

/** Persist only OS-encrypted registrations; unavailable encryption fails explicitly. */
export function enrollmentStore(directory, secureStorage) {
  const filename = join(directory, 'registration.bin')
  function available() {
    if (!secureStorage?.isEncryptionAvailable() || secureStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('SECURE_STORAGE_UNAVAILABLE')
  }
  return {
    async load() {
      let bytes
      try { bytes = await readFile(filename) }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('REGISTRATION_UNREADABLE') }
      available()
      if (bytes.length > 16384) throw new Error('REGISTRATION_UNREADABLE')
      try { return parseEnrollment(JSON.parse(secureStorage.decryptString(bytes))) }
      catch { throw new Error('REGISTRATION_UNREADABLE') }
    },
    async save(enrollment) {
      available()
      const encrypted = secureStorage.encryptString(JSON.stringify(parseEnrollment(enrollment)))
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') await chmod(directory, 0o700)
      const temporary = join(directory, randomUUID() + '.tmp')
      let failure
      try {
        await writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' })
        await rename(temporary, filename)
      } catch (error) { failure = error }
      try { await unlink(temporary) } catch (error) { if (error.code !== 'ENOENT') failure ??= error }
      if (failure) throw failure
    },
  }
}
