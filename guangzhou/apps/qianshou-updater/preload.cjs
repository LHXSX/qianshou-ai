const { contextBridge, ipcRenderer } = require('electron')
const actions = new Set(['snapshot', 'check', 'install', 'cancel', 'hide'])
contextBridge.exposeInMainWorld('qianshouUpdate', {
  invoke(action) {
    if (!actions.has(action)) return Promise.resolve({ ok: false, error: 'INVALID_ACTION' })
    return ipcRenderer.invoke('qianshou:update-center', action)
  },
  subscribe(listener) {
    const receive = (_event, state) => listener(state)
    ipcRenderer.on('qianshou:update-state', receive)
    return () => ipcRenderer.removeListener('qianshou:update-state', receive)
  },
})
