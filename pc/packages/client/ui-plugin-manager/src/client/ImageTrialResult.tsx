/** Original-PNG preview and explicit result actions; no action submits from an effect. */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import type { ImageTrialKey } from './image-trial-locales.ts'
import css from './ImageTrialResult.module.css'

/** Display only the local URL and PNG bytes already verified by the image transport.
 * @param props - Verified original, localized actions and optional explicit regeneration callback.
 * @returns A clickable image, preview dialog, image-byte clipboard action and original download.
 */
export function ImageTrialResult({ src, png, filename, width, height, onImageError, onRegenerate, onClearer, onHighDefinition, t }: {
  src: string
  png: Blob
  filename: string
  width: number
  height: number
  onImageError: () => void
  onRegenerate?: () => Promise<boolean>
  onClearer?: () => Promise<boolean>
  onHighDefinition?: () => Promise<boolean>
  t: (key: ImageTrialKey) => string
}) {
  const [open, setOpen] = useState(false)
  const [originalSize, setOriginalSize] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [note, setNote] = useState<{ key: ImageTrialKey; error: boolean } | null>(null)
  const [copying, setCopying] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [upgrade, setUpgrade] = useState<12 | 20 | null>(null)
  const regenerateLock = useRef(false)
  const copyLock = useRef(false)
  const live = useRef(true)
  const menuRef = useRef(menu)
  menuRef.current = menu
  const opener = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const previewBody = useRef<HTMLDivElement>(null)
  const upgradeHint = useId()
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    if (!open) return
    closeButton.current?.focus()
    const menuEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || menuRef.current === null) return
      event.preventDefault(); event.stopImmediatePropagation(); setMenu(null)
    }
    document.addEventListener('keydown', menuEscape, true)
    return () => { document.removeEventListener('keydown', menuEscape, true); opener.current?.focus() }
  }, [open])
  const close = useCallback(() => {
    setMenu(null); setOpen(false)
  }, [])
  const imageFailed = (): void => { setNote({ key: 'imageError', error: true }); onImageError() }
  const contextMenu = (event: MouseEvent): void => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY })
  }
  const download = (): void => {
    try {
      const anchor = document.createElement('a')
      anchor.href = src; anchor.download = filename
      document.body.appendChild(anchor)
      try { anchor.click() } finally { anchor.remove() }
      setNote(null)
    } catch { setNote({ key: 'downloadFailed', error: true }) }
  }
  const copy = (): void => {
    if (copyLock.current) return
    copyLock.current = true; setCopying(true); setNote(null)
    const write = async (): Promise<void> => {
      const clipboard = (navigator as unknown as { readonly clipboard?: Clipboard }).clipboard
      if (typeof clipboard?.write !== 'function' || typeof ClipboardItem !== 'function') {
        throw new Error('image clipboard unavailable')
      }
      await clipboard.write([new ClipboardItem({ 'image/png': png })])
    }
    void write().then(() => {
      if (live.current) setNote({ key: 'copied', error: false })
    }).catch(() => {
      if (live.current) setNote({ key: 'copyFailed', error: true })
    }).finally(() => {
      copyLock.current = false
      if (live.current) setCopying(false)
    })
  }
  const regenerate = (action = onRegenerate): void => {
    if (action === undefined || regenerateLock.current) return
    regenerateLock.current = true; setRegenerating(true); setNote(null)
    setUpgrade(null)
    void Promise.resolve().then(action).then((accepted) => {
      if (live.current) setNote({ key: accepted ? 'regenerateSubmitted' : 'regenerateFailed', error: !accepted })
    }).catch(() => {
      if (live.current) setNote({ key: 'regenerateFailed', error: true })
    }).finally(() => {
      regenerateLock.current = false
      if (live.current) setRegenerating(false)
    })
  }
  const feedback = note === null ? null : <p className={css.feedback} role={note.error ? 'alert' : 'status'}>{t(note.key)}</p>
  return <div className={css.result}>
    <button ref={opener} type="button" className={css.thumbnail} aria-label={t('openImage')}
      title={t('openImage')} onClick={() => { setMenu(null); setOpen(true) }} onContextMenu={contextMenu}>
      <img className={css.image} src={src} alt={t('image')} onError={imageFailed} />
    </button>
    <div className={css.actions}>
      {onRegenerate !== undefined && <button type="button" disabled={regenerating}
        onClick={() => { regenerate() }}>{t(regenerating ? 'regenerating' : 'regenerate')}</button>}
      <button type="button" disabled={regenerating || onClearer === undefined} aria-describedby={upgradeHint}
        onClick={() => { setUpgrade(12) }}>{t('clearer')}</button>
      <button type="button" disabled={regenerating || onHighDefinition === undefined} aria-describedby={upgradeHint}
        onClick={() => { setUpgrade(20) }}>{t('highDefinition')}</button>
      <a href={src} download={filename}>{t('download')}</a>
      <button type="button" disabled={copying} onClick={copy}>{t(copying ? 'copying' : 'copyImage')}</button>
    </div>
    <small id={upgradeHint} className={css.hint}>{t(onClearer !== undefined || onHighDefinition !== undefined
      ? 'upgradePresets' : 'upgradesUnavailable')}</small>
    {feedback}
    <Modal open={upgrade !== null} onClose={() => { setUpgrade(null) }}
      title={t(upgrade === 12 ? 'clearer' : 'highDefinition')} closeLabel={t('closeUpgrade')}>
      <div className={css.upgradeBody}>
        <p>{t('upgradeConfirm').replace('{steps}', String(upgrade))}</p>
        <div className={css.actions}>
          <button type="button" onClick={() => { setUpgrade(null) }}>{t('cancelUpgrade')}</button>
          <button type="button" disabled={regenerating} onClick={() => { regenerate(upgrade === 12 ? onClearer : onHighDefinition) }}>
            {t('startUpgrade')}
          </button>
        </div>
      </div>
    </Modal>
    <Modal open={open} onClose={close} title={t('imagePreview')} headless className={clsx(css.preview)}>
      <div ref={previewBody} className={css.previewBody} onKeyDown={(event) => {
        if (event.key !== 'Tab' || menuRef.current !== null) return
        const controls = previewBody.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')
        const first = controls?.[0]; const last = controls?.[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }}>
        <div className={css.previewToolbar}>
          <strong>{t('imagePreview')}</strong>
          <button type="button" aria-pressed={originalSize} onClick={() => { setOriginalSize(value => !value) }}>
            {t(originalSize ? 'fitImage' : 'originalSize')}
          </button>
          <button ref={closeButton} type="button" onClick={() => { setMenu(null); setOpen(false) }}>{t('closePreview')}</button>
        </div>
        <div className={css.imageViewport}>
          <img className={originalSize ? css.originalSize : css.original} src={src} alt={t('image')}
            width={width} height={height} onContextMenu={contextMenu} onError={imageFailed} />
        </div>
        <div className={css.actions}>
          <button type="button" disabled={copying} onClick={copy}>{t(copying ? 'copying' : 'copyImage')}</button>
          <a href={src} download={filename}>{t('download')}</a>
        </div>
        {feedback}
      </div>
    </Modal>
    <Menu open={menu !== null} autoFocus portal anchor={<span />} items={[
      { id: 'download', label: t('downloadOriginal') },
      { id: 'copy', label: t(copying ? 'copying' : 'copyImage'), disabled: copying },
    ]} getAnchorRect={() => menu === null ? null : new DOMRect(menu.x, menu.y, 0, 0)}
    onClose={() => { setMenu(null) }} onSelect={(action) => {
      setMenu(null)
      if (action === 'copy') copy()
      else if (action === 'download') download()
    }} />
  </div>
}
