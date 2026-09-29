/** Non-secret browser identity keeps durable PC commands attached to the same device after reload. */
const key = 'qianshou.mobile-preview.device-id.v1'

/**
 * Read or persist one opaque browser installation id; storage failure prevents startup.
 * @param storage - Browser-owned durable key/value store; never stores account credentials here.
 * @param uuid - UUID source used only for first initialization.
 * @returns The persisted device identifier.
 */
export function readDeviceId(storage: Pick<Storage, 'getItem' | 'setItem'>, uuid: () => string): string {
  const prior = storage.getItem(key)
  if (prior !== null) {
    if (!/^mobile-web-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(prior)) throw new Error('PREVIEW_DEVICE_ID_INVALID')
    return prior
  }
  const created = `mobile-web-${uuid()}`
  storage.setItem(key, created)
  return created
}
