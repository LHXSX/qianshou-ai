/** Browser-owned durable outbox with revision checks; never stores model or account credentials. */
import type { WindowBinding, WindowJournal, WindowJournalStore } from './types.ts'
import { originKey, parseJournal } from './validation.ts'

/** Open one database owned by the embedding application. Close it on the owning lifecycle's disposal. */
export class IndexedDbWindowJournalStore implements WindowJournalStore {
  private constructor(private readonly db: IDBDatabase) {}

  /**
   * Open or create the outbox object store. Rejects unavailable storage rather than falling back to volatile memory.
   * @param factory - The embedding browser's IndexedDB factory.
   * @param name - Application-owned database name, isolated from other features and test databases.
   * @returns An open journal store; rejects failed or blocked opening and closes a late blocked result.
   */
  static open(factory: IDBFactory, name: string): Promise<IndexedDbWindowJournalStore> {
    return new Promise((resolve, reject) => {
      const request = factory.open(name, 1)
      let blocked = false
      request.onupgradeneeded = () => { request.result.createObjectStore('outbox') }
      request.onerror = () => { reject(request.error ?? new Error('PC_WINDOW_STORAGE_OPEN_FAILED')) }
      request.onblocked = () => { blocked = true; reject(new Error('PC_WINDOW_STORAGE_BLOCKED')) }
      request.onsuccess = () => {
        const db = request.result
        if (blocked) { db.close(); return }
        db.onversionchange = () => { db.close() }
        resolve(new IndexedDbWindowJournalStore(db))
      }
    })
  }

  /** Return untrusted persisted data; the controller validates it before exposing a snapshot. */
  load(binding: WindowBinding): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = this.db.transaction('outbox', 'readonly').objectStore('outbox').get(originKey(binding))
      request.onsuccess = () => { resolve(request.result ?? null) }
      request.onerror = () => { reject(request.error ?? new Error('PC_WINDOW_STORAGE_READ_FAILED')) }
    })
  }

  /** Atomically compare the stored revision and persist a complete journal, rejecting races between browser windows. */
  save(journal: WindowJournal, expectedRevision: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction('outbox', 'readwrite')
      const store = transaction.objectStore('outbox')
      const key = originKey(journal.binding)
      const read = store.get(key)
      let reason: Error | null = null
      read.onsuccess = () => {
        try {
          const current = read.result === undefined ? 0 : parseJournal(read.result, journal.binding).revision
          if (current !== expectedRevision || journal.revision !== expectedRevision + 1) throw new Error('PC_WINDOW_STALE_LOCAL_REVISION')
          store.put(journal, key)
        } catch (error) {
          reason = error instanceof Error ? error : new Error('PC_WINDOW_STORAGE_WRITE_FAILED')
          transaction.abort()
        }
      }
      transaction.oncomplete = () => { resolve() }
      transaction.onabort = transaction.onerror = () => { reject(reason ?? transaction.error ?? new Error('PC_WINDOW_STORAGE_WRITE_FAILED')) }
    })
  }

  /** Delete only the selected origin's local echoes, without issuing a PC cancellation. */
  remove(binding: WindowBinding): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction('outbox', 'readwrite')
      transaction.objectStore('outbox').delete(originKey(binding))
      transaction.oncomplete = () => { resolve() }
      transaction.onabort = transaction.onerror = () => { reject(transaction.error ?? new Error('PC_WINDOW_STORAGE_DELETE_FAILED')) }
    })
  }

  /** Release the browser database connection. */
  close(): void { this.db.close() }
}
