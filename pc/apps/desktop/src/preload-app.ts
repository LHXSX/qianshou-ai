/** Origin-scoped boot, native directory selection, and update presentation with native confirmation actions. */

import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC, SCHEME, type DshDesktopProductApi, type DesktopUpdatePresentation, type DesktopDevicePreferences } from './ipc.ts'
import { markDocumentPlatform } from './preload-platform.ts'
import { syncNativeTheme } from './preload-theme.ts'
import { syncWindowsAppearance } from './preload-windows.ts'

const product: DshDesktopProductApi = {
  protocolVersion: 1,
  updates: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.updatesStatus) as Promise<DesktopUpdatePresentation>,
    open: () => ipcRenderer.invoke(DESKTOP_IPC.updatesOpen) as Promise<void>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopUpdatePresentation): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.updatesPresentation, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.updatesPresentation, handle) }
    },
  },
  device: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.devicePreferencesStatus) as Promise<DesktopDevicePreferences>,
    set: (name, enabled) => ipcRenderer.invoke(DESKTOP_IPC.devicePreferencesSet, name, enabled) as Promise<DesktopDevicePreferences>,
  },
}

if (location.protocol === `${SCHEME}:` && location.hostname === 'app') {
  syncWindowsAppearance()
  contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
    pick: () => ipcRenderer.invoke(DESKTOP_IPC.directoryPick) as Promise<string | null>,
  })
  contextBridge.exposeInMainWorld('__DSH_H3_FILE_PICKER__', {
    file: (purpose: 'first-frame' | 'workflow' | 'model' | 'python' | 'ffmpeg' | 'ffprobe') =>
      ipcRenderer.invoke(DESKTOP_IPC.h3SetupFilePick, purpose) as Promise<string | null>,
  })
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    ready: () => ipcRenderer.invoke(DESKTOP_IPC.boot) as Promise<unknown>,
    failed: (message: string) => ipcRenderer.invoke(DESKTOP_IPC.bootFailed, message) as Promise<void>,
  })
}

markDocumentPlatform()
syncNativeTheme()
// Main-process IPC also verifies the owning window and top frame.
contextBridge.exposeInMainWorld('dshDesktop', location.protocol === `${SCHEME}:` && location.hostname === 'app' ? product : { protocolVersion: 1 })
