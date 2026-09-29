/** Account-scoped generated pictures; credentials never enter this store. */

export interface StoredGeneratedImage {
  readonly sessionKey?: string
  readonly id: string
  readonly prompt: string
  readonly dataUri: string
  readonly mimeType: string
  readonly at: number
  readonly caption: string
  readonly operation?: 'generate' | 'edit'
}

export interface ImageAlbumRecord {
  readonly accountId: string
  readonly images: readonly StoredGeneratedImage[]
  readonly lastPrompt: string
  readonly userTurnsSinceImage: number
}

const DB = 'qianshou-mobile-preview-images-v1'
const STORE = 'album'
const DATA_URI = /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/
const MIME = /^image\/(?:jpeg|png|webp|gif)$/

/**
 * Accept only a well-formed album. Garbage or credential-shaped values are dropped.
 * @param value - Parsed JSON or IDB result.
 */
export function parseImageAlbum(value: unknown): ImageAlbumRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(row.accountId)) return null
  if (typeof row.lastPrompt !== 'string' || row.lastPrompt.length > 8_000) return null
  if (typeof row.userTurnsSinceImage !== 'number' || !Number.isInteger(row.userTurnsSinceImage)
    || row.userTurnsSinceImage < 0 || row.userTurnsSinceImage > 10_000) return null
  if (!Array.isArray(row.images) || row.images.length > 40) return null
  const images: StoredGeneratedImage[] = []
  for (const item of row.images) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
    const image = item as Record<string, unknown>
    if (typeof image.id !== 'string' || image.id.length > 160) return null
    if (typeof image.prompt !== 'string' || image.prompt.length > 8_000) return null
    if (typeof image.dataUri !== 'string' || image.dataUri.length > 12_000_000 || !DATA_URI.test(image.dataUri)) return null
    if (typeof image.mimeType !== 'string' || !MIME.test(image.mimeType)) return null
    if (typeof image.at !== 'number' || !Number.isFinite(image.at)) return null
    if (typeof image.caption !== 'string' || image.caption.length > 200) return null
    if (image.operation !== undefined && image.operation !== 'generate' && image.operation !== 'edit') return null
    if (image.sessionKey !== undefined && (typeof image.sessionKey !== 'string' || image.sessionKey.length > 256 || image.sessionKey.length === 0)) return null
    images.push({
      ...(typeof image.sessionKey === 'string' ? { sessionKey: image.sessionKey } : {}),
      id: image.id, prompt: image.prompt, dataUri: image.dataUri, mimeType: image.mimeType,
      at: image.at, caption: image.caption,
      ...(image.operation === undefined ? {} : { operation: image.operation }),
    })
  }
  return { accountId: row.accountId, images, lastPrompt: row.lastPrompt, userTurnsSinceImage: row.userTurnsSinceImage }
}

function requestOf<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('IMAGE_ALBUM_REQUEST')) }
  })
}

/**
 * @param idb - Browser IndexedDB factory; missing implementations return a no-op store.
 */
export async function openImageAlbum(idb: IDBFactory | undefined): Promise<{
  load(accountId: string): Promise<ImageAlbumRecord | null>
  save(record: ImageAlbumRecord): Promise<void>
  close(): void
}> {
  const empty = {
    load: async () => null,
    save: async () => {},
    close: () => {},
  }
  if (idb === undefined || typeof idb.open !== 'function') return empty
  let db: IDBDatabase
  try {
    const open = idb.open(DB, 1)
    open.onupgradeneeded = () => { open.result.createObjectStore(STORE) }
    db = await requestOf(open)
  } catch {
    return empty
  }
  return {
    async load(accountId) {
      try {
        const tx = db.transaction(STORE, 'readonly')
        const raw = await requestOf(tx.objectStore(STORE).get(accountId))
        const parsed = parseImageAlbum(raw)
        return parsed?.accountId === accountId ? parsed : null
      } catch {
        return null
      }
    },
    async save(record) {
      const parsed = parseImageAlbum(record)
      if (parsed === null) return
      try {
        const tx = db.transaction(STORE, 'readwrite')
        await requestOf(tx.objectStore(STORE).put(parsed, parsed.accountId))
      } catch {
        // Private mode can refuse durable writes; the live transcript still holds the pictures.
      }
    },
    close() { db.close() },
  }
}
