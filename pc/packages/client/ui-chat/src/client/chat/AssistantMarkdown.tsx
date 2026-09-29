import { Fragment, memo, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { JsonBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownFileMentions, MarkdownMediaLinks, MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives'
import { isAbsoluteWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { AssistantBlock } from '../contract/snapshot.ts'
import { markdownLabels } from '../markdown-labels.ts'
import { ReasoningRow } from './ReasoningRow.tsx'
import { useSearchableHidden } from './searchable-hidden.ts'
import { IMAGE_PROGRESS_TEXT, imageProgressValue } from './image-progress.ts'
import css from './AssistantMarkdown.module.css'

/**
 * Map one authored media destination to the same-origin workspace-file URL.
 * @param protocol - `window.location.protocol` at render time.
 * @param origin - `window.location.origin` at render time.
 * @param value - The authored markdown destination, exactly as written.
 * @param hostname - The current page hostname; Electron uses the owned `app` host.
 * @returns The authenticated Host file URL for an absolute Host path, or
 * undefined when the current page cannot address the Host file route.
 */
export function localPathMediaUrl(protocol: string, origin: string, value: string, hostname = ''): string | undefined {
  if (value.length === 0 || !isAbsoluteWorkspacePath(value) || value.startsWith('//') || value.startsWith('\\\\')
    || /[\u0000-\u001f\u007f]/u.test(value)) return undefined
  const base = protocol === 'dsh-app:' && hostname === 'app' ? 'dsh-app://app'
    : protocol === 'http:' || protocol === 'https:' ? origin : undefined
  return base === undefined ? undefined : `${base}/api/file?path=${encodeURIComponent(value)}`
}

const TASK_MEDIA_REFERENCE = new RegExp(
  '^qianshou-media://task/([A-Za-z0-9][A-Za-z0-9._-]{0,127})/'
    + '([a-f0-9]{64})\\.(png|jpe?g|webp|gif|mp4|webm|mov)$',
  'u',
)
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif)$/iu
const VIDEO_EXTENSION = /\.(?:mp4|webm|mov|m4v)$/iu

/**
 * Translate only an opaque task/asset reference into a same-origin read route.
 * The route must authenticate the viewer and verify the task's asset receipt
 * before serving bytes. This helper does not turn arbitrary URLs into media.
 * @param protocol - The active page protocol.
 * @param origin - The active HTTP(S) page origin.
 * @param value - The complete opaque task media reference.
 * @param hostname - The active page hostname for the Electron app route.
 * @returns An authenticated same-origin URL, or undefined for an invalid reference or origin.
 */
export function taskMediaReferenceUrl(protocol: string, origin: string, value: string, hostname = ''): string | undefined {
  const match = TASK_MEDIA_REFERENCE.exec(value)
  if (match === null || match[1] === '.' || match[1] === '..') return undefined
  const base = protocol === 'dsh-app:' && hostname === 'app' ? 'dsh-app://app'
    : protocol === 'http:' || protocol === 'https:' ? origin : undefined
  if (base === undefined) return undefined
  return `${base}/api/qianshou/result-media?task_id=${encodeURIComponent(match[1] ?? '')}&asset_id=${match[2]}&type=${match[3]}`
}

export interface AssistantMarkdownProps {
  blocks: readonly AssistantBlock[]
  streaming: boolean
  /** Frozen partial of an aborted turn: rendered with a stopped marker. */
  interrupted?: boolean | undefined
  /** Render consecutive image blocks through the attachment slot. */
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  /** Hide reasoning that belongs to the Turn-level process disclosure. */
  reasoningHidden?: boolean | undefined
  /** Reveal the owning Turn-level process disclosure. */
  revealProcess?: (() => void) | undefined
  /** Resolved prose file mentions for this Assistant's closing turn. */
  mentions?: MarkdownFileMentions | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/** Reasoning block as the Think variant summary row (figma 39:28304). */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  blocks, streaming, interrupted, renderMessageImages,
  reasoningHidden = false, revealProcess, mentions, t,
}: AssistantMarkdownProps) {
  // Stable per locale revision (t identity changes on switch): a fresh object
  // per render would rebuild MarkdownText's component table every chunk.
  const labels = useMemo(() => markdownLabels(t), [t])
  // Local media paths in the closing prose rewrite to the same-origin file
  // API (policy re-validation lives host-side). The vocabulary identity is
  // stable per page load because MarkdownText memoizes on it.
  const pathImages = useMemo<MarkdownPathImages>(() => {
    const { protocol, origin, hostname } = window.location
    return { resolve: (value) => {
      if (TASK_MEDIA_REFERENCE.test(value)) return IMAGE_EXTENSION.test(value)
        ? taskMediaReferenceUrl(protocol, origin, value, hostname) : undefined
      return localPathMediaUrl(protocol, origin, value, hostname)
    } }
  }, [])
  const mediaLinks = useMemo<MarkdownMediaLinks>(() => {
    const { protocol, origin, hostname } = window.location
    return { resolve: (value) => {
      if (!VIDEO_EXTENSION.test(value)) return undefined
      const src = TASK_MEDIA_REFERENCE.test(value)
        ? taskMediaReferenceUrl(protocol, origin, value, hostname)
        : (() => {
          if (value.includes('?') || value.includes('#')) return undefined
          try { return localPathMediaUrl(protocol, origin, decodeURIComponent(value), hostname) }
          catch { return undefined }
        })()
      return src === undefined ? undefined : { kind: 'video', src }
    } }
  }, [])
  const last = blocks.length - 1
  // Tool-call heads render as tool rows in the chat view's grouping pass, so
  // a node that is only those heads (or empty) would paint an empty root
  // between tool groups — skip the shell unless something visible remains.
  const hasVisible = streaming
    || interrupted === true
    || blocks.some(block => block.kind !== 'tool-call')
  if (!hasVisible) return null
  const rendered: ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block === undefined) continue
    switch (block.kind) {
      case 'text':
        rendered.push(streaming && block.text === IMAGE_PROGRESS_TEXT
          ? <ImageProgress key={i} label={t('message.imageProgress')} />
          : (
            <MarkdownText
              key={i}
              text={block.text}
              streaming={streaming}
              labels={labels}
              fileMentions={mentions}
              pathImages={pathImages}
              mediaLinks={mediaLinks}
            />
          ))
        break
      case 'reasoning':
        rendered.push(
          <ProcessReasoning
            key={i}
            hidden={reasoningHidden}
            reveal={revealProcess}
          >
            <ReasoningRow text={block.text} running={streaming && i === last} t={t} />
          </ProcessReasoning>,
        )
        break
      case 'image': {
        // Consecutive image blocks share one gallery so several images tile
        // into rows instead of each opening a one-image group of its own.
        // Keyed by the group's FIRST block index: a streaming append that
        // extends the group then only grows `images` instead of remounting
        // the gallery under a shifted key.
        const start = i
        const group = [block]
        while (i + 1 < blocks.length) {
          const next = blocks[i + 1]
          if (next === undefined || next.kind !== 'image') break
          group.push(next)
          i += 1
        }
        rendered.push(
          <Fragment key={start}>
            {renderMessageImages({
              images: group.map(({ attachment }) => ({ attachment })),
              align: 'start',
            })}
          </Fragment>,
        )
        break
      }
      // Grouped into tool rows by ChatView; hasVisible above skips an empty shell.
      case 'tool-call':
        break
      default:
        rendered.push(
          <JsonBlock
            key={i}
            label={t('message.unknownBlock')}
            payload={block.block}
            truncatedLabel={total => t('json.truncated', { total })}
          />,
        )
    }
  }
  return (
    <div className={css.root} data-streaming={streaming || undefined}>
      <div className={css.body}>
        {rendered}
        {interrupted && <span className={css.stopped}>{t('message.stopped')}</span>}
      </div>
    </div>
  )
})

function ProcessReasoning({ hidden, reveal, children }: {
  hidden: boolean
  reveal?: (() => void) | undefined
  children: ReactNode
}) {
  const ref = useSearchableHidden(hidden, reveal ?? NOOP)
  return <div ref={ref} data-turn-process-inline={hidden || undefined}>{children}</div>
}

const NOOP = (): void => {}

/** Determinate wait bar for a picture that has not returned yet. */
function ImageProgress({ label }: { label: string }) {
  const [value, setValue] = useState(4)
  useEffect(() => {
    const started = Date.now()
    const tick = (): void => { setValue(imageProgressValue(Date.now() - started)) }
    tick()
    const id = setInterval(tick, 200)
    return () => { clearInterval(id) }
  }, [])
  return (
    <div className={css.imageProgress}>
      <div className={css.imageProgressLabel}>{label}</div>
      <div
        className={css.imageProgressTrack}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-label={label}
      >
        <div className={css.imageProgressFill} style={{ width: `${value}%` }} />
      </div>
    </div>
  )
}
