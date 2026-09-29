/** Permissions for the Qianshou product document; media capture is microphone-only. */

import type { BrowserWindow, Session, WebContents } from 'electron'
import { SCHEME } from './ipc.ts'

function isProductUrl(value: string | undefined): boolean {
  if (value === undefined) return false
  try {
    const url = new URL(value)
    return url.protocol === `${SCHEME}:` && url.hostname === 'app' && url.port === ''
      && url.username === '' && url.password === ''
  } catch { return false }
}

/**
 * Install application-lifetime permissions on the product session. OS microphone consent remains required.
 * Other windows, subframes, cameras, screen capture, and unknown permission types are denied.
 * @param browserSession - The session carrying the owned application window.
 * @param getWindow - Current product window; checked again for each permission decision.
 */
export function installProductPermissions(browserSession: Session, getWindow: () => BrowserWindow | undefined): void {
  const owns = (contents: WebContents | null, isMainFrame: boolean, requestingUrl?: string): boolean => {
    const window = getWindow()
    return window !== undefined && !window.isDestroyed() && contents === window.webContents
      && !contents.isDestroyed() && isMainFrame && isProductUrl(contents.getURL()) && isProductUrl(requestingUrl)
  }
  // These document operations are also used by ordinary copy/paste and presentation controls.
  const documentPermissions = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'])
  browserSession.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (!owns(contents, details.isMainFrame, details.requestingUrl) || !isProductUrl(origin)) return false
    if (permission !== 'media') return documentPermissions.has(permission)
    return details.mediaType === 'audio'
      && (details.securityOrigin === undefined || isProductUrl(details.securityOrigin))
  })
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!owns(contents, details.isMainFrame, details.requestingUrl)) { callback(false); return }
    if (permission !== 'media') { callback(documentPermissions.has(permission)); return }
    const media = details as Electron.MediaAccessPermissionRequest
    callback(media.mediaTypes?.length === 1 && media.mediaTypes[0] === 'audio'
      && (media.securityOrigin === undefined || isProductUrl(media.securityOrigin)))
  })
}
