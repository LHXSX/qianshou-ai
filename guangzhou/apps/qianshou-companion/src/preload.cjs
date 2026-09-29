const { contextBridge, ipcRenderer } = require('electron')
const actions = new Set(['snapshot', 'application-ready', 'updates', 'connect', 'disconnect', 'approve', 'reject', 'cancel', 'choose-folder', 'remove-folder', 'forget-pairing', 'rustdesk', 'copy'])
contextBridge.exposeInMainWorld('qianshou', {
  invoke(action, payload) {
    if (!actions.has(action)) return Promise.resolve({ ok: false, error: 'INVALID_ACTION' })
    return ipcRenderer.invoke(`qianshou:${action}`, payload)
  },
  onState(listener) {
    const handler = (_event, state) => listener(state)
    ipcRenderer.on('qianshou:state', handler)
    return () => ipcRenderer.removeListener('qianshou:state', handler)
  },
})
