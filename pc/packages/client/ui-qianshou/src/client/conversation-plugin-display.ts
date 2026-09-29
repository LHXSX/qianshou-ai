/** Readable card titles keep generated local package identities in technical details. */
const GENERATED_LOCAL_TITLE = /^qianshou-local-[a-f\d]{32}$/u

/**
 * Choose a compact display title without changing a plugin's identity.
 * @param title - Original installed title, retained unchanged for manually named plugins.
 * @param description - Public description of a generated local package.
 * @param fallback - Localized local-plugin label when the description has no readable heading.
 * @returns A display-only title; borrowing and Host verification still use the original title and id.
 */
export function conversationPluginDisplayTitle(title: string, description: string, fallback: string): string {
  if (!GENERATED_LOCAL_TITLE.test(title)) return title
  const heading = description.trim().split(/[:：。.!?！？\r\n]/u, 1)[0]?.trim() ?? ''
  if (heading === '') return fallback
  const characters = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    .segment(heading.replace(/\s+/gu, ' ')), item => item.segment)
  return characters.length > 36 ? characters.slice(0, 36).join('') + '…' : characters.join('')
}
