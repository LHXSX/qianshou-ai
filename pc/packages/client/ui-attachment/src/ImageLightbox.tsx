import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ImageLightbox.module.css'

/** Lightbox strings the owner resolves from its own locale namespace. */
export interface ImageLightboxLabels {
  /** Accessible name of the preview dialog. */
  dialog: string
  /** Accessible label of the close control. */
  close: string
}

/** Copy and save controls shown on an opened original. */
export interface ImageLightboxActions {
  /** Copy-control label. */
  copy: string
  /** Save-control label. */
  save: string
  /** Right-click download label. */
  download: string
  /** Status after a copy attempt; null before the user copies. */
  note: string | null
  /** Write the open image to the clipboard. */
  onCopy: () => void
  /** Download the open image. */
  onSave: () => void
}

/**
 * Document-level original-image preview opened by clicking a thumbnail.
 * Closes on Escape, backdrop press, or the close control, and restores focus
 * to the opener on unmount. Rendered through a body portal: an opener inside
 * a transformed or filtered ancestor would otherwise trap the fixed backdrop
 * in that ancestor's box instead of covering the viewport.
 *
 * @param props.src - the original image URL.
 * @param props.alt - the image's alt text.
 * @param props.labels - dialog and close-control strings.
 * @param props.actions - copy and save controls for the open image.
 * @param props.onClose - dismiss callback owned by the opener.
 * @returns the modal preview dialog.
 */
export function ImageLightbox({ src, alt, labels, actions, onClose }: {
  src: string
  alt: string
  labels: ImageLightboxLabels
  actions?: ImageLightboxActions
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef(menu)
  menuRef.current = menu

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (menuRef.current !== null) {
        setMenu(null)
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      restoreRef.current?.focus()
    }
  }, [onClose])

  useEffect(() => {
    if (menu === null) return
    const close = (): void => { setMenu(null) }
    window.addEventListener('mousedown', close)
    return () => { window.removeEventListener('mousedown', close) }
  }, [menu])

  return createPortal(
    <div
      className={css.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={labels.dialog}
    >
      <div className={css.mask} aria-hidden="true" onMouseDown={onClose} />
      <img
        className={css.image}
        src={src}
        alt={alt}
        onContextMenu={(event) => {
          if (actions === undefined) return
          event.preventDefault()
          const width = 180
          const height = 96
          setMenu({
            x: Math.max(8, Math.min(event.clientX, window.innerWidth - width)),
            y: Math.max(8, Math.min(event.clientY, window.innerHeight - height)),
          })
        }}
      />
      {menu !== null && actions !== undefined && (
        <div
          className={css.menu}
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => { event.stopPropagation() }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              actions.onCopy()
              setMenu(null)
            }}
          >{actions.copy}</button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              actions.onSave()
              setMenu(null)
            }}
          >{actions.download}</button>
          {actions.note !== null && <span className={css.note} role="status">{actions.note}</span>}
        </div>
      )}
      {actions !== undefined && (
        <div className={css.toolbar}>
          <button type="button" className={css.action} onClick={actions.onCopy}>{actions.copy}</button>
          <button type="button" className={css.action} onClick={actions.onSave}>{actions.save}</button>
          {actions.note !== null && <span className={css.note} role="status">{actions.note}</span>}
        </div>
      )}
      <button ref={closeRef} type="button" className={css.close} aria-label={labels.close} onClick={onClose}>
        <IconCloseOutline16 size={16} />
      </button>
    </div>,
    document.body,
  )
}
