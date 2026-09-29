/** Bounded archive download and offline integrity verification; does not extract or install files. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import { assertUpdateResponse, assertVerifiedRelease, updateOperation, UpdateError } from './manifest.mjs'

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000

async function checkedDirectory(directory, create) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new UpdateError('UNSAFE_CACHE', 'Update cache must be an absolute directory')
  const absolute = path.resolve(directory)
  let current = path.parse(absolute).root
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    if (create) {
      try { await mkdir(current, { mode: 0o700 }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new UpdateError('UNSAFE_CACHE', 'Update paths must not contain symlinks or non-directories')
  }
  const info = await lstat(absolute)
  if (process.platform !== 'win32' && ((info.mode & 0o022) !== 0 || (process.getuid && info.uid !== process.getuid()))) {
    throw new UpdateError('UNSAFE_CACHE', 'Update cache must be private to the current user')
  }
  if (await realpath(absolute) !== absolute) throw new UpdateError('UNSAFE_CACHE', 'Update cache must use its real directory path')
  return { absolute, info }
}

async function unchangedDirectory(directory, previous) {
  const next = await lstat(directory)
  if (!next.isDirectory() || next.isSymbolicLink() || next.dev !== previous.dev || next.ino !== previous.ino) {
    throw new UpdateError('UNSAFE_CACHE', 'Update cache directory changed during the operation')
  }
}

function progress(callback, received, total) {
  try { callback?.({ received, total, fraction: received / total }) }
  catch { /* Presentation observers cannot interrupt the integrity or cleanup paths. */ }
}

/**
 * Verify a persisted archive against a freshly verified signed release, without loading it into memory.
 * @param {object} verified A result from verifyReleaseEnvelope or checkForUpdate in this process.
 * @param {string} archivePath Absolute regular-file path, with no symlink ancestor.
 * @param {{signal?:AbortSignal}} options Optional cancellation.
 * @returns {Promise<object>} Exact file path, SHA-256 and byte size.
 */
export async function verifyArchive(verified, archivePath, { signal } = {}) {
  try { return await checkArchiveFile(verified, archivePath, signal) }
  catch (error) {
    if (signal?.aborted) throw signal.reason
    if (error instanceof UpdateError) throw error
    throw new UpdateError('UPDATE_IO', 'Could not read the update archive')
  }
}

async function checkArchiveFile(verified, archivePath, signal) {
  assertVerifiedRelease(verified)
  if (typeof archivePath !== 'string' || !path.isAbsolute(archivePath)) throw new UpdateError('UNSAFE_ARCHIVE', 'Archive path must be absolute')
  await checkedDirectory(path.dirname(archivePath), false)
  signal?.throwIfAborted()
  const before = await lstat(archivePath)
  if (!before.isFile() || before.isSymbolicLink()) throw new UpdateError('UNSAFE_ARCHIVE', 'Update archive must be a regular file')
  const file = await open(archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== verified.artifact.size) {
      throw new UpdateError('UPDATE_SIZE', 'Update archive size or identity does not match')
    }
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted()
      size += chunk.length
      if (size > verified.artifact.size) throw new UpdateError('UPDATE_SIZE', 'Update archive exceeds its signed size')
      hash.update(chunk)
    }
    signal?.throwIfAborted()
    const sha256 = hash.digest('hex')
    const after = await file.stat()
    if (size !== verified.artifact.size || sha256 !== verified.artifact.sha256
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new UpdateError('UPDATE_INTEGRITY', 'Update archive integrity verification failed')
    }
    return Object.freeze({ path: archivePath, size, sha256 })
  } finally { await file.close() }
}

/**
 * Stream a selected newer release into a private cache and publish it only after exact size/SHA verification.
 * @param {object} available The non-serialized available result returned by checkForUpdate.
 * @param {{cacheDirectory:string,signal?:AbortSignal,onProgress?:(value:object)=>void}} options Data-independent cache and UI observer.
 * @param {{fetchImpl?:typeof fetch}} dependencies Tests may inject fetch; the signed artifact URL remains fixed.
 * @returns {Promise<object>} Verified archive path and signed release envelope for staging and offline bootstrap verification.
 */
export async function downloadUpdate(available, { cacheDirectory, signal, onProgress }, { fetchImpl = globalThis.fetch } = {}) {
  try { return await downloadArchive(available, { cacheDirectory, signal, onProgress, fetchImpl }) }
  catch (error) {
    if (signal?.aborted) throw signal.reason
    if (error instanceof UpdateError) throw error
    throw new UpdateError('UPDATE_DOWNLOAD', 'Could not download the update archive')
  }
}

async function downloadArchive(available, { cacheDirectory, signal, onProgress, fetchImpl }) {
  assertVerifiedRelease(available)
  if (available.status !== 'available') throw new UpdateError('UPDATE_NOT_AVAILABLE', 'Only a newer release can be downloaded')
  signal?.throwIfAborted()
  const cache = await checkedDirectory(cacheDirectory, true)
  const directory = path.join(cache.absolute, randomUUID())
  await mkdir(directory, { mode: 0o700 })
  const identity = await lstat(directory)
  const partial = path.join(directory, '.archive.part')
  const destination = path.join(directory, available.artifact.fileName)
  const operation = updateOperation(signal, DOWNLOAD_TIMEOUT_MS)
  let file
  let response
  let completed = false
  try {
    operation.signal.throwIfAborted()
    await unchangedDirectory(cache.absolute, cache.info)
    file = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    response = await fetchImpl(available.artifact.url, { redirect: 'error', credentials: 'omit', cache: 'no-store', signal: operation.signal })
    assertUpdateResponse(response, available.artifact.url, available.artifact.size)
    const length = response.headers.get('content-length')
    if (length !== null && Number(length) !== available.artifact.size) throw new UpdateError('UPDATE_SIZE', 'Response length differs from its signed size')
    let size = 0
    const hash = createHash('sha256')
    progress(onProgress, 0, available.artifact.size)
    for await (const chunk of response.body) {
      operation.signal.throwIfAborted()
      size += chunk.byteLength
      if (size > available.artifact.size) throw new UpdateError('UPDATE_SIZE', 'Update archive exceeds its signed size')
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset)
        if (bytesWritten === 0) throw new UpdateError('UPDATE_WRITE', 'Update archive write made no progress')
        offset += bytesWritten
      }
      progress(onProgress, size, available.artifact.size)
    }
    operation.signal.throwIfAborted()
    const sha256 = hash.digest('hex')
    if (size !== available.artifact.size || sha256 !== available.artifact.sha256) throw new UpdateError('UPDATE_INTEGRITY', 'Update archive integrity verification failed')
    await file.sync()
    await file.close()
    file = undefined
    await unchangedDirectory(cache.absolute, cache.info)
    await unchangedDirectory(directory, identity)
    operation.signal.throwIfAborted()
    await rename(partial, destination)
    const result = Object.freeze({ path: destination, size, sha256, version: available.version,
      artifact: available.artifact, release: available.release, envelope: available.envelope })
    completed = true
    return result
  } catch (error) {
    if (operation.signal.aborted) throw operation.signal.reason
    throw error
  } finally {
    operation.dispose()
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => { /* Body is already complete or failed. */ })
    if (file) await file.close()
    if (!completed) {
      // Only this operation's random directory is removable, and never through a replaced symlink.
      await unchangedDirectory(cache.absolute, cache.info)
      await unchangedDirectory(directory, identity)
      await rm(directory, { recursive: true, force: true })
    }
  }
}
