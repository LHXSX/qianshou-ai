/** Localized copy adapters for Cordis-free Markdown primitives. */

import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from './contract/slots.ts'

/**
 * Build the complete Markdown chrome copy for one locale revision.
 * @param t - Chat locale seat.
 * @returns Labels for code fences and footnotes.
 */
export function markdownLabels(t: ChatViewSlotProps['t']): MarkdownLabels {
  return {
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('markdown.footnotes'),
    image: {
      title: t('image.title'),
      preview: t('image.preview'),
      close: t('image.close'),
      copy: t('image.copy'),
      copied: t('image.copied'),
      copyFailed: t('image.copyFailed'),
      download: t('image.download'),
      downloaded: t('image.downloaded'),
      downloadFailed: t('image.downloadFailed'),
      zoomIn: t('image.zoomIn'),
      zoomOut: t('image.zoomOut'),
      zoomLevel: t('image.zoomLevel'),
      fit: t('image.fit'),
    },
  }
}
