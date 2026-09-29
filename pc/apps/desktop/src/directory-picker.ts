/** Window-owned workspace directory dialogs for the local Desktop renderer. */

import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { DESKTOP_IPC, assertDesktopSender } from './ipc.ts'

/**
 * Install the application-lifetime directory picker IPC handler.
 * @param getWindow - Current local application window; shell pages and subframes cannot open dialogs.
 */
export function installDesktopDirectoryPicker(getWindow: () => BrowserWindow | undefined): void {
  const pending = new WeakMap<BrowserWindow, Promise<string | null>>()
  ipcMain.handle(DESKTOP_IPC.directoryPick, async (event) => {
    const window = getWindow()
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('dsh desktop: rejected directory picker from an unowned renderer')
    }
    assertDesktopSender(event, ['app'])
    const existing = pending.get(window)
    if (existing !== undefined) return existing
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    const result = dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] }).then(
      ({ canceled, filePaths }) => window.isDestroyed() || canceled ? null : filePaths[0] ?? null,
    ).finally(() => { pending.delete(window) })
    pending.set(window, result)
    return result
  })
  installH3SetupFilePicker(getWindow)
}

/** Fixed-purpose file selection; callers cannot supply filters or arbitrary dialog settings. */
function installH3SetupFilePicker(getWindow: () => BrowserWindow | undefined): void {
  const purposes: Record<string, { readonly name: string; readonly extensions: string[] }> = {
    'first-frame': { name: 'PNG', extensions: ['png'] },
    workflow: { name: 'Workflow', extensions: ['json'] },
    model: { name: 'Model', extensions: ['safetensors', 'gguf', 'pt', 'pth', 'bin'] },
    python: { name: 'Python', extensions: ['exe', '*'] },
    ffmpeg: { name: 'FFmpeg', extensions: ['exe', '*'] },
    ffprobe: { name: 'FFprobe', extensions: ['exe', '*'] },
  }
  const pending = new WeakMap<BrowserWindow, { readonly purpose: string; readonly result: Promise<string | null> }>()
  ipcMain.handle(DESKTOP_IPC.h3SetupFilePick, async (event, ...args: unknown[]) => {
    const window = getWindow()
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('dsh desktop: rejected H3 file picker from an unowned renderer')
    }
    assertDesktopSender(event, ['app'])
    const purpose = args[0]
    if (args.length !== 1 || typeof purpose !== 'string' || !Object.hasOwn(purposes, purpose)) {
      throw new Error('dsh desktop: rejected H3 file picker purpose')
    }
    const filter = purposes[purpose]
    if (filter === undefined) throw new Error('dsh desktop: rejected H3 file picker purpose')
    const existing = pending.get(window)
    if (existing !== undefined) {
      if (existing.purpose !== purpose) throw new Error('dsh desktop: H3 file picker busy')
      return existing.result
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    const result = dialog.showOpenDialog(window, {
      properties: ['openFile'], filters: [filter],
    }).then(({ canceled, filePaths }) => window.isDestroyed() || canceled ? null : filePaths[0] ?? null)
      .finally(() => { pending.delete(window) })
    pending.set(window, { purpose, result })
    return result
  })
}
