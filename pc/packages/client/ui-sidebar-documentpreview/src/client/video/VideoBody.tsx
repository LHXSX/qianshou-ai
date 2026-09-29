/** Browser video playback through the Host's authenticated, ranged file route. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { isAbsoluteWorkspacePath, pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { hostFileOf, type SessionFile } from '../rpc.ts'
import type { DocumentPreviewProps } from '../document/contract.ts'
import type {} from './locales.ts'
import css from './VideoBody.module.css'

/** Renderer-owned metadata read; bytes remain on the Host file route. */
export interface VideoBodyInjected {
  readVideo: (file: SessionFile, signal: AbortSignal) => Promise<RemoteResult<WorkspaceFileStat>>
}

type VideoSource = {
  readonly revision: number
  readonly address: string
  readonly url: string
  readonly version: string
  readonly failed: boolean
}

/**
 * Build a same-origin URL for the already-authorized Host file path.
 * @param path - Absolute path returned by the Session file service.
 * @param pageUrl - Current Web or owned Electron app page.
 * @returns The local ranged-media endpoint or undefined for unsupported origins and paths.
 */
export function videoFileUrl(path: string, pageUrl: string): string | undefined {
  if (!isAbsoluteWorkspacePath(path) || path.startsWith('//') || path.startsWith('\\\\')
    || /[\u0000-\u001f\u007f]/u.test(path)) return undefined
  const page = new URL(pageUrl)
  const base = page.protocol === 'dsh-app:' && page.hostname === 'app' && page.port === ''
    && page.username === '' && page.password === '' ? 'dsh-app://app'
    : page.protocol === 'http:' || page.protocol === 'https:' ? page.origin : undefined
  return base === undefined ? undefined : `${base}/api/file?path=${encodeURIComponent(path)}`
}

/**
 * Render a manual-play video without copying it into the Client or a Blob.
 * @param props - Session file address, renderer revision, and metadata reader.
 * @returns A controlled native player or a localized loading/failure state.
 */
export function VideoBody({ resourceAddress, content, readVideo, t }: DocumentPreviewProps
  & InjectFace<VideoBodyInjected> & PropsLocale<'sidebarVideo'>): ReactNode {
  const file = useMemo(() => hostFileOf(resourceAddress), [resourceAddress])
  const revision = content.kind === 'renderer' ? content.revision : undefined
  const [source, setSource] = useState<VideoSource>()
  useEffect(() => {
    if (revision === undefined) return
    const controller = new AbortController()
    void readVideo(file, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (!result.ok) {
        setSource({ revision, address: resourceAddress, url: '', version: '', failed: true })
        return
      }
      const url = videoFileUrl(result.value.absolutePath, window.location.href)
      setSource(url === undefined || result.value.bytes === 0
        ? { revision, address: resourceAddress, url: '', version: '', failed: true }
        : { revision, address: resourceAddress, url, version: result.value.version, failed: false })
    }, () => {
      if (!controller.signal.aborted) setSource({ revision, address: resourceAddress, url: '', version: '', failed: true })
    })
    return () => { controller.abort() }
  }, [file, readVideo, resourceAddress, revision])

  if (revision === undefined) return <p className={css.status} role="alert">{t('failed')}</p>
  const current = source?.revision === revision && source.address === resourceAddress ? source : undefined
  if (current === undefined) return <LoadingIndicator className={css.status} label={t('loading')} />
  if (current.failed) return <p className={css.status} role="alert">{t('failed')}</p>
  const { name } = pathPartsOf(file.path)
  return <div className={css.frame} data-video-preview>
    <video key={current.url} className={css.video} src={current.url}
      aria-label={t('preview', { name })} controls playsInline preload="metadata"
      onLoadedMetadata={() => { if (content.kind === 'renderer') content.loaded(current.version) }}
      onError={() => { setSource(state => state === current ? { ...current, failed: true } : state) }} />
  </div>
}
