/** User-selected text import and explicit local export; no directory scanning or legacy DB migration. */
const MAX_DOCUMENT_BYTES = 512 * 1024
/**
 * Read bounded strict UTF-8 into an unsaved draft.
 * @param file - User-selected file.
 * @returns Original text with a filename title.
 */
export async function importText(file: File): Promise<{ title: string; content: string; source: string }> {
  if (file.size > MAX_DOCUMENT_BYTES || !/\.(txt|md|markdown|json|csv|ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|css|html|yml|yaml)$/i.test(file.name)) throw new Error('invalid-request')
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer())
  if (!content.trim() || content.includes('\0')) throw new Error('invalid-request')
  return { title: file.name.slice(0, 160), content, source: file.name }
}
/**
 * Download a complete owner export using the browser's standard save path.
 * @param content - Valid complete JSON.
 */
export function downloadExport(content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'qianshou-device-memory.json'
  anchor.click()
  setTimeout(() =>{  URL.revokeObjectURL(url) }, 1000)
}
