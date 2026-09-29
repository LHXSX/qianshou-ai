/**
 * Copy a loaded image onto the clipboard as PNG, or download it under a file name.
 * The page already holds the bytes at `src` (a blob or same-origin URL).
 */

/**
 * Download name for one image. A bare title gets a `.png` suffix.
 * @param name - display name, possibly empty or containing slashes.
 * @returns a file name with an image extension.
 */
export function imageFileName(name: string): string {
  const trimmed = name.trim().replace(/[\\/]/g, '-')
  const base = trimmed === '' ? 'qianshou' : trimmed
  return /\.(png|jpe?g|gif|webp)$/i.test(base) ? base : `${base}.png`
}

/**
 * Write the image at `src` to the clipboard as PNG.
 * @param src - blob or same-origin URL of the loaded image.
 * @returns a promise that rejects when the bytes or the clipboard write fail.
 */
export async function copyImage(src: string): Promise<void> {
  const response = await fetch(src)
  if (!response.ok) throw new Error('image fetch failed')
  const blob = await response.blob()
  const png = blob.type === 'image/png' ? blob : await pngBlob(blob)
  const write = navigator.clipboard?.write
  if (write === undefined || typeof ClipboardItem !== 'function') throw new Error('image clipboard unavailable')
  await write([new ClipboardItem({ 'image/png': png })])
}

/**
 * Download the loaded image URL under `name`.
 * @param src - blob or same-origin URL of the loaded image.
 * @param name - display name used as the download file name.
 */
export function saveImage(src: string, name: string): void {
  const anchor = document.createElement('a')
  anchor.href = src
  anchor.download = imageFileName(name)
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/** Rasterize a non-PNG blob so the clipboard receives `image/png`. */
function pngBlob(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (context === null) {
        URL.revokeObjectURL(url)
        reject(new Error('image canvas unavailable'))
        return
      }
      context.drawImage(image, 0, 0)
      canvas.toBlob((png) => {
        URL.revokeObjectURL(url)
        if (png === null) reject(new Error('image png conversion failed'))
        else resolve(png)
      }, 'image/png')
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image decode failed'))
    }
    image.src = url
  })
}
