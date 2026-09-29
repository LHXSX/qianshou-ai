/** Inline previews for media explicitly delivered by a completed turn. */
import { useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { basename, presentedPreviewUrl } from '../presented.ts'
import css from './Deliverables.module.css'

type MediaKind = 'image' | 'video'

/** Media category and same-origin file URL for one declared delivery. */
export interface PresentedMediaSource {
  readonly kind: MediaKind
  readonly url: string
}

/**
 * Address delivered media on the current authenticated Web or desktop origin.
 * @param path - The exact path recorded by `deliverables/presented`.
 * @param coordinates - The owning Session and durable delivery's event/file coordinates.
 * @param pageUrl - The current page URL, including the desktop scheme host.
 * @returns A media source, or null when the path cannot be served safely.
 */
export function presentedMediaSource(
  path: string, coordinates: { sessionId: string; seq: number; index: number }, pageUrl: string,
): PresentedMediaSource | null {
  if (!path || /[\u0000-\u001f\u007f]/u.test(path) || /^[a-z][a-z\d+.-]*:\/\//iu.test(path)) return null
  const page = new URL(pageUrl)
  const origin = page.protocol === 'dsh-app:'
    ? page.hostname === 'app' && page.port === '' && page.username === '' && page.password === ''
      ? 'dsh-app://app' : null
    : page.protocol === 'http:' || page.protocol === 'https:' ? page.origin : null
  if (origin === null) return null
  const extension = /\.([a-z0-9]+)$/i.exec(basename(path))?.[1]?.toLowerCase()
  const kind: MediaKind | null = extension !== undefined && ['png', 'apng', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'].includes(extension)
    ? 'image'
    : extension !== undefined && ['mp4', 'm4v', 'webm', 'ogv', 'mov'].includes(extension) ? 'video' : null
  if (kind === null) return null
  const resource = presentedPreviewUrl(coordinates.sessionId, coordinates.seq, coordinates.index)
  return resource === null ? null : { kind, url: `${origin}${resource}` }
}

/**
 * Show the delivered media above its retained file card; a failed media load
 * leaves the card as the available file action.
 * @param props - Source URL and recorded display name.
 * @returns An image or controlled media player, or null after load failure.
 */
export function PresentedMediaPreview({ source, path, labels }: {
  source: PresentedMediaSource
  path: string
  labels?: MarkdownLabels
}) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  const name = basename(path)
  return <figure className={css.mediaItem} data-presented-media={source.kind}>
    {source.kind === 'image'
      ? labels === undefined
        ? <img className={css.mediaContent} src={source.url} alt={name} loading="lazy" onError={() => { setFailed(true) }} />
        : <MarkdownText text={`![${name.replace(/[\[\]\\]/gu, '\\$&')}](/qianshou-presented-image)`} labels={labels}
          pathImages={{ resolve: destination => destination === '/qianshou-presented-image' ? source.url : undefined }} />
      : <video className={css.mediaContent} src={source.url} aria-label={name}
        controls preload="metadata" playsInline onError={() => { setFailed(true) }} />}
    <figcaption className={css.mediaCaption}>{name}</figcaption>
  </figure>
}
