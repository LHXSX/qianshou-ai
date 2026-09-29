/** Local image viewing controls inside the existing Markdown primitive. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Modal } from '../Modal.tsx'
import type { MarkdownLabels } from './render.tsx'
import { copyMarkdownImage, downloadMarkdownImage } from './image-actions.ts'
import css from './InteractiveImage.module.css'

type ImageLabels = NonNullable<MarkdownLabels['image']>

/** Show an authorized image with visible actions and a keyboard-accessible zoom dialog. */
export function InteractiveImage({ src, alt, destination, labels, onError }: {
  src: string
  alt: string
  destination: string
  labels: ImageLabels
  onError: () => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [size, setSize] = useState({ width: 0, height: 0 })
  const opener = useRef<HTMLButtonElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!open) return
    close.current?.focus()
    return () => { opener.current?.focus() }
  }, [open])
  const act = async (kind: 'copy' | 'download') => {
    if (busy) return
    setBusy(true); setNotice('')
    try {
      if (kind === 'copy') await copyMarkdownImage(src)
      else await downloadMarkdownImage(src, alt || destination)
      if (alive.current) setNotice(kind === 'copy' ? labels.copied : labels.downloaded)
    } catch {
      if (alive.current) setNotice(kind === 'copy' ? labels.copyFailed : labels.downloadFailed)
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const fit = size.width > 0 && size.height > 0
    ? Math.min(size.width, window.innerWidth * 0.78, window.innerHeight * 0.65 * size.width / size.height) : undefined
  const actions = <>
    <button type="button" disabled={busy} onClick={() => { void act('copy') }}>{labels.copy}</button>
    <button type="button" disabled={busy} onClick={() => { void act('download') }}>{labels.download}</button>
  </>
  return <span className={css.root}>
    <button ref={opener} type="button" className={css.open} aria-label={`${labels.preview}: ${alt || labels.title}`}
      onClick={() => { setZoom(1); setNotice(''); setOpen(true) }}>
      <img className={css.image} src={src} alt={alt} onError={onError}
        onLoad={(event) => { setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }) }}
        loading="lazy" decoding="async" referrerPolicy="no-referrer" />
    </button>
    <span className={css.toolbar}>
      <button type="button" onClick={() => { setZoom(1); setNotice(''); setOpen(true) }}>{labels.preview}</button>
      {actions}
    </span>
    {!open && notice && <span role="status" className={css.notice}>{notice}</span>}
    <Modal open={open} onClose={() => { setOpen(false) }} title={labels.title} headless className={clsx(css.dialog)}>
      <div className={css.viewer} onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const first = buttons[0]; const last = buttons.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }}>
        <div className={css.toolbar}>
          <strong>{alt || labels.title}</strong>
          <button type="button" disabled={zoom <= 1} onClick={() => { setZoom(value => Math.max(1, value - 0.5)) }}
            aria-label={labels.zoomOut}>−</button>
          <output aria-label={labels.zoomLevel}>{Math.round(zoom * 100)}%</output>
          <button type="button" disabled={zoom >= 4} onClick={() => { setZoom(value => Math.min(4, value + 0.5)) }}
            aria-label={labels.zoomIn}>+</button>
          <button type="button" onClick={() => { setZoom(1) }}>{labels.fit}</button>
          {actions}
          <button ref={close} type="button" onClick={() => { setOpen(false) }}>{labels.close}</button>
        </div>
        <div className={css.stage}>
          <img src={src} alt={alt} style={{ width: fit === undefined ? undefined : `${fit * zoom}px` }}
            onError={onError} decoding="async" referrerPolicy="no-referrer" />
        </div>
        {notice && <span role="status" className={css.notice}>{notice}</span>}
      </div>
    </Modal>
  </span>
}
