/** Supported source formats are decoded strictly as UTF-8, never parsed or executed. */
export const TEXT_IMPORT_ACCEPT = '.txt,.md,.markdown,.json,.csv,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.hpp,.css,.html,.xml,.yaml,.yml,.toml,.sh,.sql,.log'
/** Maximum bytes permitted for one imported source file. */
export const MEMORY_IMPORT_LIMIT = 512 * 1024
/**
 * Validate and read a user-selected plain-text source without executing it.
 * @param file - The browser's explicitly selected file.
 * @returns Original decoded content and the browser-provided filename.
 */
export async function importMemoryText(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<{ title: string; content: string; source: string }> {
  if (file.size > MEMORY_IMPORT_LIMIT) throw new Error('IMPORT_TOO_LARGE')
  const extension = '.' + (file.name.split('.').pop() ?? '').toLowerCase()
  if (!TEXT_IMPORT_ACCEPT.split(',').includes(extension)) throw new Error('IMPORT_UNSUPPORTED')
  let content: string
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()) }
  catch { throw new Error('IMPORT_NOT_UTF8') }
  if (content.includes('\u0000')) throw new Error('IMPORT_BINARY')
  return { title: file.name, content, source: file.name }
}
