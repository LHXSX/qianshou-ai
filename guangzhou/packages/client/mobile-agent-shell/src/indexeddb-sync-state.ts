/** Browser-owned durable sync cursor; never stores credentials, tokens or conversation text. */
import { parseMobileSyncState, type MobileSyncState, type MobileSyncStatePort } from './sync-state.ts'

/** One IndexedDB-backed cursor record, isolated per participant key. */
export class IndexedDbMobileSyncState implements MobileSyncStatePort {
  private current: MobileSyncState | null

  private constructor(private readonly db: IDBDatabase, private readonly key: string, stored: unknown) {
    this.current = parseMobileSyncState(stored)
  }

  /**
   * Open or create the cursor store for one participant.
   * @param factory - The embedding browser's IndexedDB factory.
   * @param name - Application-owned database name, isolated from other features.
   * @param key - Participant key, so two accounts on one origin never share a cursor.
   * @returns An open state port; rejects unavailable storage rather than falling back to memory.
   */
  static open(factory: IDBFactory, name: string, key: string): Promise<IndexedDbMobileSyncState> {
    return new Promise((resolve, reject) => {
      const request = factory.open(name, 1)
      let blocked = false
      request.onupgradeneeded = () => { request.result.createObjectStore('cursor') }
      request.onerror = () => { reject(request.error ?? new Error('MOBILE_SYNC_STORAGE_OPEN_FAILED')) }
      request.onblocked = () => { blocked = true; reject(new Error('MOBILE_SYNC_STORAGE_BLOCKED')) }
      request.onsuccess = () => {
        const db = request.result
        if (blocked) { db.close(); return }
        db.onversionchange = () => { db.close() }
        const read = db.transaction('cursor', 'readonly').objectStore('cursor').get(key)
        read.onsuccess = () => { resolve(new IndexedDbMobileSyncState(db, key, read.result)) }
        read.onerror = () => { db.close(); reject(read.error ?? new Error('MOBILE_SYNC_STORAGE_READ_FAILED')) }
      }
    })
  }

  /** @returns The last committed state, or `null` before this participant has synced. */
  snapshot(): MobileSyncState | null { return this.current }

  /** Commit the next cursor and revision; a failed write leaves the previous state intact. */
  save(state: MobileSyncState): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction('cursor', 'readwrite')
      transaction.objectStore('cursor').put(state, this.key)
      transaction.oncomplete = () => { this.current = state; resolve() }
      transaction.onabort = transaction.onerror = () => { reject(transaction.error ?? new Error('MOBILE_SYNC_STORAGE_WRITE_FAILED')) }
    })
  }

  /** Release the browser database connection. */
  close(): void { this.db.close() }
}
