/** Put image downloads from the chat into the user's Downloads folder. */

import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Session } from 'electron'

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i

/**
 * Choose an unused path in `directory` for an image download.
 * @param directory - destination folder, already resolved by the caller.
 * @param filename - download item name. Only a bare image name is accepted.
 * @param exists - path probe, defaulting to the filesystem.
 * @returns the save path, or undefined when the name is not an image file.
 */
export function imageSavePath(
  directory: string,
  filename: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const name = basename(filename)
  if (name !== filename || !IMAGE_EXTENSION.test(name)) return undefined
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? name : `${stem} ${index + 1}${extension}`
    const path = join(directory, candidate)
    if (!exists(path)) return path
  }
  return join(directory, `${stem} ${Date.now()}${extension}`)
}

/**
 * Save image downloads under the downloads directory. Other downloads keep Electron's default path.
 * @param browserSession - session that owns the chat window.
 * @param downloadsDirectory - folder returned when a download starts.
 */
export function installImageDownloads(browserSession: Session, downloadsDirectory: () => string): void {
  browserSession.on('will-download', (_event, item) => {
    const path = imageSavePath(downloadsDirectory(), item.getFilename())
    if (path !== undefined) item.setSavePath(path)
  })
}
