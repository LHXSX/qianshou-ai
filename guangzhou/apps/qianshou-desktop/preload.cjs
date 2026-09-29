// Sandboxed Electron preloads require CommonJS; no Node API crosses this bridge.
const { contextBridge, ipcRenderer } = require('electron')
// A successful document load alone does not prove that the client plugins mounted.
window.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('root')
  if (!root) return
  const announce = () => {
    if (root.dataset.dshBootState !== 'ready') return
    observer.disconnect()
    ipcRenderer.send('qianshou:application-ready')
  }
  const observer = new MutationObserver(announce)
  observer.observe(root, { attributes: true, attributeFilter: ['data-dsh-boot-state'] })
  announce()
}, { once: true })
contextBridge.exposeInMainWorld('qianshouDesktop', Object.freeze({
  relay: Object.freeze({
    status: () => ipcRenderer.invoke('qianshou:relay-status'),
    importConfig: () => ipcRenderer.invoke('qianshou:relay-import'),
    setEnabled: enabled => ipcRenderer.invoke('qianshou:relay-enable', enabled),
  }),
  openRustDesk: (id) => ipcRenderer.invoke('qianshou:open-rustdesk', id),
}))
