/** Image actions retain the renderer's already-authorized source URL. */

/** Read one image without changing its signed URL or delegating to an external host. */
async function imageBlob(src: string): Promise<Blob> {
  const response = await fetch(src)
  if (!response.ok) throw new Error('image read failed')
  const blob = await response.blob()
  if (!blob.type.startsWith('image/')) throw new Error('image response has no image type')
  return blob
}

/** Convert only clipboard bytes; downloads keep their original format. */
function clipboardPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return Promise.resolve(blob)
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    const release = () => { URL.revokeObjectURL(url) }
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (context === null) { release(); reject(new Error('image canvas unavailable')); return }
      context.drawImage(image, 0, 0)
      canvas.toBlob((png) => {
        release()
        if (png === null) reject(new Error('image conversion failed'))
        else resolve(png)
      }, 'image/png')
    }
    image.onerror = () => { release(); reject(new Error('image decode failed')) }
    image.src = url
  })
}

/** Begin the clipboard write during the click gesture, retaining async image loading. */
export async function copyMarkdownImage(src: string): Promise<void> {
  const clipboard = Reflect.get(navigator, 'clipboard') as Clipboard | undefined
  if (clipboard === undefined || typeof Reflect.get(clipboard, 'write') !== 'function' || typeof ClipboardItem !== 'function') {
    throw new Error('image clipboard unavailable')
  }
  const png = imageBlob(src).then(clipboardPng)
  // Permission rejection can precede completion of the image read.
  void png.catch(() => {})
  const item = new ClipboardItem({ 'image/png': png })
  await clipboard.write([item])
}

/** Download exact bytes as a local blob, so cross-origin anchors cannot silently open a page. */
export async function downloadMarkdownImage(src: string, name: string): Promise<void> {
  const blob = await imageBlob(src)
  const extensions: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  }
  const extension = extensions[blob.type] ?? 'png'
  const base = name.split(/[\\/]/u).at(-1)?.replace(/[\u0000-\u001f\u007f<>:"|?*]/gu, '-').trim() || 'qianshou'
  const filename = /\.(?:png|jpe?g|webp|gif|avif|svg|bmp)$/iu.test(base) ? base : `${base}.${extension}`
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // The native download handler consumes the URL asynchronously after click.
  setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
}
