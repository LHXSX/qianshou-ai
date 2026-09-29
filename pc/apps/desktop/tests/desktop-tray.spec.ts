import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  class FakeTray extends EventEmitter {
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn()
    readonly destroy = vi.fn()
    constructor(readonly image: unknown) { super() }
  }
  return {
    app: Object.assign(new EventEmitter(), { isPackaged: false, getAppPath: () => 'test-app', quit: vi.fn() }),
    image: { isEmpty: vi.fn(() => false), setTemplateImage: vi.fn() },
    createFromPath: vi.fn(),
    buildFromTemplate: vi.fn(),
    FakeTray,
  }
})

vi.mock('electron', () => ({
  app: fixture.app,
  Menu: { buildFromTemplate: fixture.buildFromTemplate },
  nativeImage: { createFromPath: fixture.createFromPath },
  Tray: fixture.FakeTray,
}))

import { installQianshouTray } from '../src/desktop-tray.ts'
import { zh } from '../src/locale.ts'
const qianshouZh = { ...zh, application: '千手 PC' }

beforeEach(() => {
  fixture.app.removeAllListeners()
  fixture.app.isPackaged = false
  fixture.app.quit.mockReset()
  fixture.image.isEmpty.mockReturnValue(false)
  fixture.image.setTemplateImage.mockReset()
  fixture.createFromPath.mockReset().mockReturnValue(fixture.image)
  fixture.buildFromTemplate.mockReset().mockImplementation(items => ({ items }))
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
})

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('Qianshou native tray', () => {
  it('uses the macOS template mark and restores the window without changing acceptance state', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    const show = vi.fn()
    const tray = installQianshouTray(show, qianshouZh) as unknown as InstanceType<typeof fixture.FakeTray>
    expect(fixture.createFromPath).toHaveBeenCalledWith(join('test-app', 'resources', 'qianshou-tray-macosTemplate.png'))
    expect(fixture.image.setTemplateImage).toHaveBeenCalledWith(true)
    expect(tray.setToolTip).toHaveBeenCalledWith('千手 PC')
    const menu = fixture.buildFromTemplate.mock.lastCall![0] as Array<{ label?: string; click?: () => void }>
    expect(menu.map(item => item.label).filter(Boolean)).toEqual(['打开千手', '退出'])
    menu[0]!.click!()
    expect(show).toHaveBeenCalledOnce()
    expect(fixture.app.quit).not.toHaveBeenCalled()
    menu[2]!.click!()
    expect(fixture.app.quit).toHaveBeenCalledOnce()
    fixture.app.emit('will-quit')
    expect(tray.destroy).toHaveBeenCalledOnce()
  })

  it('uses the packaged Windows icon and restores on taskbar click', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32', resourcesPath: 'packaged-resources' })
    fixture.app.isPackaged = true
    const show = vi.fn()
    const tray = installQianshouTray(show, qianshouZh) as unknown as InstanceType<typeof fixture.FakeTray>
    expect(fixture.createFromPath).toHaveBeenCalledWith(join('packaged-resources', 'qianshou-tray-windows.png'))
    expect(fixture.image.setTemplateImage).not.toHaveBeenCalled()
    tray.emit('click')
    tray.emit('double-click')
    expect(show).toHaveBeenCalledTimes(2)
  })

  it('keeps the window usable if the tray resource cannot be read', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    fixture.image.isEmpty.mockReturnValue(true)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(installQianshouTray(vi.fn(), zh)).toBeUndefined()
    expect(fixture.buildFromTemplate).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('does not add a tray to other profiles', () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    expect(installQianshouTray(vi.fn(), zh)).toBeUndefined()
    expect(fixture.createFromPath).not.toHaveBeenCalled()
  })
})
