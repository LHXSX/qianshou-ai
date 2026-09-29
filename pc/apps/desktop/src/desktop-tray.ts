/** Qianshou's native menu bar / notification area entry. No task state is inferred here. */
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import type { DesktopMessages } from './locale.ts'

export function installQianshouTray(showWindow: () => void, messages: DesktopMessages): Tray | undefined {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'qianshou'
    || (process.platform !== 'darwin' && process.platform !== 'win32')) return undefined

  const resourceRoot = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const imagePath = join(resourceRoot, process.platform === 'darwin'
    ? 'qianshou-tray-macosTemplate.png' : 'qianshou-tray-windows.png')
  const image = nativeImage.createFromPath(imagePath)
  if (image.isEmpty()) {
    console.error(`Qianshou tray image is missing or unreadable: ${imagePath}`)
    return undefined
  }
  if (process.platform === 'darwin') image.setTemplateImage(true)

  const tray = new Tray(image)
  tray.setToolTip(messages.application)
  const items: MenuItemConstructorOptions[] = [
    { label: messages.showMainWindow, click: showWindow },
    { type: 'separator' },
    { label: messages.exitApplication, click: () => app.quit() },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(items))
  if (process.platform === 'win32') {
    tray.on('click', showWindow)
    tray.on('double-click', showWindow)
  }
  app.once('will-quit', () => tray.destroy())
  return tray
}
