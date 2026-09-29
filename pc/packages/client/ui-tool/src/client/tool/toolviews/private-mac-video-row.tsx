/** Deterministic playback of a Host-vouched private Mac trial tool result. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import { IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallOwnerProps } from '../../contract/slots.ts'
import { CONVERSATION_NS as NS } from '../../locale.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { toolRowModel } from '../models/tool-call-model.ts'
import css from './private-mac-video-row.module.css'

// This view consumes only these owner fields. The slot supplies the wider
// session standard kit at runtime, but a direct component test need not fake it.
type VideoRowProps = Pick<ToolCallOwnerProps, 'toolName' | 'block' | 'inspect'> & PropsLocale<'conversation'>
const TOOL = 'plugin_drawn_video_try_local'
const DIGEST = /^[a-f0-9]{64}$/u

function localVideoUrl(protocol: string, origin: string, hostname: string, path: string): string | undefined {
  if (protocol !== 'http:' && protocol !== 'https:'
    && !(protocol === 'dsh-app:' && hostname === 'app')) return undefined
  const base = protocol === 'dsh-app:' ? 'dsh-app://app' : origin
  return `${base}/api/file?path=${encodeURIComponent(path)}`
}

/** The private path lives only in tool-result presentation metadata, never model content. */
export function privateMacVideoPath(block: ToolCallBlock): string | null {
  if (!('kind' in block) || block.kind !== 'tool-result' || block.isError) return null
  const value = block.meta
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (item.kind !== 'qianshou.private-mac-video-result.v1' || item.status !== 'completed'
    || item.scope !== 'private-local-trial' || item.marketInstalled !== false
    || item.dispatchable !== false || item.charged !== false || item.durationSeconds !== 5
    || typeof item.attachmentId !== 'string' || !item.attachmentId.startsWith('sha256:')
    || !DIGEST.test(item.attachmentId.slice(7))
    || !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 1
    || (item.bytes as number) > 20 * 1024 * 1024
    || typeof item.mediaMarkdown !== 'string') return null
  const match = /^\[播放视频\]\(([^)]{1,4096})\)$/u.exec(item.mediaMarkdown)
  if (!match) return null
  let path: string
  try { path = decodeURIComponent(match[1]!) } catch { return null }
  const digest = item.attachmentId.slice(7)
  const suffix = `/attachments/v1/files/${digest.slice(0, 2)}/${digest}/drawn-video-5s.mp4`
  if (!path.startsWith('/') || path.startsWith('//') || !path.endsWith(suffix)
    || path.includes('/../') || /[\u0000-\u001f\u007f]/u.test(path)) return null
  return path
}

export function PrivateMacVideoRow({ toolName, block, inspect, t }: VideoRowProps) {
  const model = toolRowModel(toolName, block)
  const path = privateMacVideoPath(block)
  const { protocol, origin, hostname } = window.location
  const src = path === null ? undefined : localVideoUrl(protocol, origin, hostname, path)
  return <div className={css.wrap}>
    <ToolRow t={t} variant={model.variant} toolName={toolName}
      icon={<IconSparkle16 size={14} />}
      title={t('tool.privateMacVideo.title')} summary={model.summary}
      output={src === undefined ? model.output : null}
      errorSummary={model.errorSummary} state={model.state} inspect={inspect} />
    {src === undefined ? null : <div className={css.media}>
      <div className={css.heading}><span>{t('tool.privateMacVideo.heading')}</span><span>{t('tool.privateMacVideo.scope')}</span></div>
      <video src={src} controls playsInline preload="metadata" aria-label={t('tool.privateMacVideo.videoAria')}
        className={css.video} />
    </div>}
  </div>
}

export const privateMacVideoToolview = {
  name: 'private-mac-video-toolview', inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key: TOOL, locale: NS,
    }, PrivateMacVideoRow))
  },
}
