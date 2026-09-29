/** Literal conversation parameters select exact official combinations, without inferred prices or altered prompts. */
import type { FormalMediaInput, FormalMediaProfile } from './formal-media-transport.ts'

export type FormalMediaIntentFailure = 'empty' | 'missingQuality' | 'missingOrientation' | 'missingSeconds' | 'conflict' | 'profileUnavailable' | 'assetsUnavailable'
function selected<T extends string>(text: string, definitions: Array<[T, RegExp]>): T | null | 'conflict' {
  const hits = definitions.filter(([, pattern]) => pattern.test(text)).map(([value]) => value)
  return hits.length > 1 ? 'conflict' : hits[0] ?? null
}
function amount(text: string): number {
  if (/^\d+$/u.test(text)) return Number(text)
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (/^[一二两三四五六七八九]$/u.test(text)) return digits[text] ?? NaN
  const match = /^(?:([一二两三四五六七八九])百)?(?:零)?(?:([一二两三四五六七八九])?十)?([一二两三四五六七八九])?$/u.exec(text)
  if (match === null || !text || text === '零') return NaN
  const hundreds = match[1] === undefined ? 0 : (digits[match[1]] ?? 0) * 100
  const tens = text.includes('十') ? (match[2] === undefined ? 1 : digits[match[2]] ?? 0) * 10 : 0
  const units = match[3] === undefined ? 0 : digits[match[3]] ?? 0
  return hundreds + tens + units
}
/** Resolve only explicit quality, orientation and duration from the user's unchanged message.
 * @param capability - The chosen @ image or video entry.
 * @param prompt - Original submitted text.
 * @param profiles - Current official directory.
 * @param assets - Guangzhou-admitted, versioned asset references.
 * @returns Exact input or a specific missing/ambiguous parameter; never a generated profile.
 */
export function formalMediaIntent(capability: 'image' | 'video', prompt: string, profiles: readonly FormalMediaProfile[],
  assets: FormalMediaInput['assets'] = []): { input: FormalMediaInput } | { error: FormalMediaIntentFailure } {
  if (!prompt.trim() || new TextEncoder().encode(prompt).byteLength > 8192) return { error: 'empty' }
  const quality = selected(prompt, [['fast', /极速|\bfast\b/iu], ['standard', /标准|\bstandard\b/iu],
    ['clear', /清晰|\bclear\b/iu], ['hd', /高清|\bhd\b/iu]])
  const orientation = selected(prompt, [['square', /方形|正方形|1[:：]1|\bsquare\b/iu],
    ['landscape', /横屏|横向|16[:：]9|\blandscape\b/iu], ['portrait', /竖屏|纵向|9[:：]16|\bportrait\b/iu]])
  if (quality === 'conflict' || orientation === 'conflict') return { error: 'conflict' }
  if (quality === null) return { error: 'missingQuality' }
  if (orientation === null) return { error: 'missingOrientation' }
  let seconds: number | null = null
  if (capability === 'video') {
    const values = [...prompt.matchAll(/(?<![\d.])([1-9]\d{0,2})(?:\s*)(?:秒|seconds?\b|s\b)/giu)].map(m => Number(m[1]))
    for (const m of prompt.matchAll(/([零一二两三四五六七八九十百半]+)\s*秒/gu)) values.push(amount(m[1] ?? ''))
    if (/分钟|minutes?\b|\d+\.\d+\s*(?:秒|seconds?\b|s\b)/iu.test(prompt)
      || values.some(n => !Number.isSafeInteger(n) || n < 1 || n > 120) || new Set(values).size > 1) return { error: 'conflict' }
    if (values.length === 0) return { error: 'missingSeconds' }
    seconds = values[0] ?? null
  } else if (/(?:\d+|[零一二两三四五六七八九十百半]+)\s*(?:秒|seconds?\b|s\b)/iu.test(prompt)) return { error: 'conflict' }
  if (capability === 'video' && /首尾|尾帧|末帧|最后一帧|last\s*frame|end\s*frame/iu.test(prompt) && assets.length !== 2) {
    return { error: 'assetsUnavailable' }
  }
  if (capability === 'video' && assets.length > 2) return { error: 'assetsUnavailable' }
  const steps = [...prompt.matchAll(/(\d+|[零一二两三四五六七八九十百半]+)\s*(?:步|steps?\b)/giu)].map(m => amount(m[1] ?? ''))
  const fps = [...prompt.matchAll(/(\d+(?:\.\d+)?)\s*(?:fps\b|帧\s*\/\s*秒|帧每秒)/giu)].map(m => Number(m[1]))
  const dimensions = [...prompt.matchAll(/(\d{2,5})\s*[×x*]\s*(\d{2,5})/giu)].map(m => [Number(m[1]), Number(m[2])])
  if (steps.some(n => !Number.isSafeInteger(n) || n < 1 || n > 200) || new Set(steps).size > 1
    || fps.some(n => !Number.isSafeInteger(n) || n < 1 || n > 120) || new Set(fps).size > 1
    || (capability === 'image' && fps.length > 0) || new Set(dimensions.map(d => d.join('x'))).size > 1) return { error: 'conflict' }
  const mode = capability === 'image' ? assets.length === 0 ? 'text_to_image'
    : /编辑|修改|重绘|\bedit\b/iu.test(prompt) ? 'image_edit' : 'image_to_image'
    : assets.length === 0 ? 'text_to_video' : assets.length === 2 ? 'first_last_frame' : 'image_to_video'
  const matching = profiles.filter(p => p.enabled && p.capability === capability && p.mode === mode && p.quality === quality
    && p.orientation === orientation && (seconds === null || p.allowed_seconds.includes(seconds))
    && assets.length <= p.max_assets && assets.every(a => p.input_roles.includes(a.role))
    && steps.every(n => n === p.steps) && fps.every(n => n === p.fps)
    && dimensions.every(([width, height]) => width === p.width && height === p.height))
  const profile = matching.length === 1 ? matching[0] : undefined
  if (profile === undefined) return { error: 'profileUnavailable' }
  return { input: { capability, mode, prompt, negative_prompt: '', quality, orientation, seconds, assets,
    profile_id: profile.profile_id, profile_version: profile.profile_version } }
}
