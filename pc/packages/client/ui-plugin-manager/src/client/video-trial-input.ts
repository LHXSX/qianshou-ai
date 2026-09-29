/** Conservative validation of explicit conversation requests; never rewrites the user's description. */
import type { SubmitAttachment } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { VIDEO_TRIAL_MAX_BYTES, type VideoTrialFrame } from './video-trial-transport.ts'
import type { VideoTrialKey } from './video-trial-locales.ts'

/** Refuse unsupported explicit parameters instead of silently substituting the trial profile. */
export function videoTrialPromptError(prompt: string): VideoTrialKey | null {
  if (!prompt.trim()) return 'empty'
  if (prompt.length > 4000) return 'tooLong'
  if (/(?:竖屏|竖版|竖向|纵向|方图|方屏|正方形|方形|portrait|square|9\s*[:：/]\s*16|1\s*[:：/]\s*1|高清|超清|更清晰|高质量|高画质|高品质|精细|标准档|质量档|high\s*quality|standard\s*quality|\bHD\b|\b[248]k\b|\b\d{3,4}p\b|尾帧|首尾|末帧|尾图|末图|最后一帧|结束帧|end\s*frame|last\s*frame)/iu.test(prompt)) return 'unsupported'
  const durations = [
    ...prompt.matchAll(/(\d+(?:\.\d+)?|[零一二两三四五六七八九十百半]+)\s*-?\s*(秒钟?|秒|分钟?|分|seconds?|secs?|s\b|minutes?|mins?)/giu),
    ...prompt.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|half)\s*-?\s*(seconds?|secs?|minutes?|mins?)\b/giu),
  ]
  if (durations.some(([, amount, unit]) => !(['5', '五', 'five'].includes(amount?.toLowerCase() ?? '')
    && /^(?:秒钟?|seconds?|secs?|s)$/iu.test(unit ?? '')))) return 'unsupported'
  if ([...prompt.matchAll(/(\d+|[零一二两三四五六七八九十百半]+|one|two|three|four|five|six|seven|eight|nine|ten)\s*-?\s*(?:步|steps?\b)/giu)]
    .some(([, steps]) => !['4', '四', 'four'].includes(steps?.toLowerCase() ?? ''))) return 'unsupported'
  if ([...prompt.matchAll(/(\d+)\s*(?:fps\b|帧\s*\/\s*秒|帧每秒)/giu)].some(([, fps]) => fps !== '24')) return 'unsupported'
  if ([...prompt.matchAll(/(\d{2,5})\s*[×x*]\s*(\d{2,5})/giu)]
    .some(([, width, height]) => width !== '1344' || height !== '768')) return 'unsupported'
  return null
}
/** Admit only one explicitly supported first-frame image; files are never silently dropped. */
export async function videoTrialFrame(attachments: readonly SubmitAttachment[]): Promise<{
  frame?: VideoTrialFrame
  sha256?: string
}> {
  if (attachments.length === 0) return {}
  const image = attachments[0]
  if (attachments.length !== 1 || image?.type !== 'image' || !['image/png', 'image/jpeg'].includes(image.mediaType)
    || image.data.length === 0 || image.data.length > Math.ceil(VIDEO_TRIAL_MAX_BYTES / 3) * 4
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(image.data)) throw new Error('VIDEO_TRIAL_INPUT_INVALID')
  const binary = atob(image.data)
  if (btoa(binary) !== image.data || binary.length > VIDEO_TRIAL_MAX_BYTES) throw new Error('VIDEO_TRIAL_INPUT_INVALID')
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  if (image.mediaType === 'image/png'
    ? ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
    : bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new Error('VIDEO_TRIAL_INPUT_INVALID')
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer)
  return { frame: { mediaType: image.mediaType as VideoTrialFrame['mediaType'], data: image.data },
    sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') }
}
