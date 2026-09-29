/** Locale-only archive failures shared by author pages; wire details remain private. */
import type { LocalSkillKey } from './local-skill-locales.ts'

/**
 * Select a finite locale key without exposing unknown transport details.
 * @param error Archive failure code from the Host.
 * @returns A known failure label or the generic archive error label.
 */
export function publicationArchiveErrorLabel(error: string): LocalSkillKey {
  switch (error) {
    case 'order-author-key-unavailable': return 'publishAuthorKeyUnavailable'
    case 'order-author-unavailable': return 'publishAuthorPlatformUnavailable'
    case 'order-archive-unavailable': return 'publishArchivePlatformUnavailable'
    case 'order-archive-untrusted-host': return 'publishArchiveUntrustedHost'
    case 'order-archive-upload-failed': return 'publishArchiveUploadFailed'
    case 'order-archive-unconfirmed': return 'publishArchiveUnconfirmed'
    default: return 'publishArchiveError'
  }
}
