import { zh } from '../locale.ts'

/** Legacy picture-wait sentence streamed by the account plugin before image bytes return. */
export const IMAGE_PROGRESS_TEXT = zh['message.imageProgress']

/**
 * Fill amount for the picture wait bar. It eases toward 92 and stays there until the picture replaces the wait sentence.
 * @param elapsedMs - time since the bar mounted.
 * @returns an integer from 4 through 92.
 */
export function imageProgressValue(elapsedMs: number): number {
  const t = Math.min(1, Math.max(0, elapsedMs) / 45_000)
  return Math.max(4, Math.round((1 - (1 - t) ** 2) * 92))
}
