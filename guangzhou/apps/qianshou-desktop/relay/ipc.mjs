/** A narrow renderer bridge; only native selection can supply a registration file. */
const errors = new Set(['INVALID_ENROLLMENT', 'INVALID_RELAY_RESOURCES', 'SECURE_STORAGE_UNAVAILABLE', 'REGISTRATION_UNREADABLE', 'RELAY_STOP_FAILED', 'RELAY_DISABLE_BEFORE_IMPORT', 'INVALID_RELAY_ACTION'])

/** Register main-frame-only relay actions and return their disposer. */
export function registerRelayIpc({ ipcMain, dialog, window, relay, trusted, ready, importTitle }) {
  const handlers = {
    'qianshou:relay-status': () => relay.status(),
    'qianshou:relay-import': async () => {
      const current = await relay.status()
      if (current.enabled) throw new Error('RELAY_DISABLE_BEFORE_IMPORT')
      const result = await dialog.showOpenDialog(window, { title: importTitle, properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (result.canceled || result.filePaths.length !== 1) return relay.status()
      return relay.importFile(result.filePaths[0])
    },
    'qianshou:relay-enable': enabled => relay.setEnabled(enabled),
  }
  for (const [channel, action] of Object.entries(handlers)) ipcMain.handle(channel, async (event, argument) => {
    if (!trusted(event)) return { ok: false, error: 'UNTRUSTED_SENDER' }
    if (!ready()) return { ok: false, error: 'BACKEND_NOT_READY' }
    try { return { ok: true, status: await action(argument) } }
    catch (error) { return { ok: false, error: errors.has(error?.message) ? error.message : 'RELAY_UNAVAILABLE' } }
  })
  return () => { for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel) }
}
