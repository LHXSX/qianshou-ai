import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogReturnValue } from 'electron'
import { DESKTOP_IPC } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({
  handle: vi.fn<(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<string | null>) => void>(),
  showOpenDialog: vi.fn<(window: BrowserWindow, options: unknown) => Promise<OpenDialogReturnValue>>(),
}))
vi.mock('electron', () => ({ ipcMain: { handle: electron.handle }, dialog: electron }))
const { installDesktopDirectoryPicker } = await import('../src/directory-picker.ts')
beforeEach(() => { vi.resetAllMocks() })

function fixture() {
  const frame = { url: 'dsh-app://app/' }
  const window = { webContents: { mainFrame: frame }, isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false), restore: vi.fn(), show: vi.fn(), focus: vi.fn() }
  installDesktopDirectoryPicker(() => window as unknown as BrowserWindow)
  const handler = electron.handle.mock.calls.find(([channel]) => channel === DESKTOP_IPC.h3SetupFilePick)![1]
  const event = { sender: window.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return { window, frame, handler, event }
}

describe('owned H3 file choices', () => {
  it('selects an actual PNG path and never accepts renderer filters', async () => {
    const f = fixture()
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['C:\\H3\\frame.png'] })
    await expect(f.handler(f.event, 'first-frame')).resolves.toBe('C:\\H3\\frame.png')
    expect(electron.showOpenDialog).toHaveBeenCalledExactlyOnceWith(f.window,
      { properties: ['openFile'], filters: [{ name: 'PNG', extensions: ['png'] }] })
    for (const args of [[], ['arbitrary'], ['__proto__'], ['first-frame', { filters: [{ extensions: ['*'] }] }]]) {
      await expect(f.handler(f.event, ...args)).rejects.toThrow('purpose')
    }
    expect(electron.showOpenDialog).toHaveBeenCalledOnce()
  })

  it('shares the same unanswered purpose but refuses conflicting dialogs', async () => {
    const f = fixture()
    let settle!: (value: OpenDialogReturnValue) => void
    electron.showOpenDialog.mockImplementation(() => new Promise((resolve) => { settle = resolve }))
    const first = f.handler(f.event, 'model')
    const second = f.handler(f.event, 'model')
    await expect(f.handler(f.event, 'workflow')).rejects.toThrow('busy')
    settle({ canceled: true, filePaths: [] })
    await expect(Promise.all([first, second])).resolves.toEqual([null, null])
    expect(electron.showOpenDialog).toHaveBeenCalledOnce()
  })

  it('rejects remote documents, other windows and subframes before any dialog', async () => {
    const f = fixture()
    await expect(f.handler({ ...f.event, sender: {} } as IpcMainInvokeEvent, 'model')).rejects.toThrow('unowned')
    await expect(f.handler({ ...f.event, senderFrame: {} } as IpcMainInvokeEvent, 'model')).rejects.toThrow('unowned')
    for (const url of ['https://example.com', 'http://127.0.0.1', 'dsh-app://shell/startup.html']) {
      f.frame.url = url
      await expect(f.handler(f.event, 'model')).rejects.toThrow('unowned')
    }
    expect(electron.showOpenDialog).not.toHaveBeenCalled()
  })

  it('discards a selected file if the owning window has been destroyed', async () => {
    const f = fixture()
    electron.showOpenDialog.mockImplementation(async () => {
      f.window.isDestroyed.mockReturnValue(true)
      return { canceled: false, filePaths: ['C:\\private.png'] }
    })
    await expect(f.handler(f.event, 'first-frame')).resolves.toBeNull()
  })
})
