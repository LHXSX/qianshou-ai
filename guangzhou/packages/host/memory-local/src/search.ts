/** Local word segmentation and bounded chunks; no embedding or LLM requests. */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

/** Tokenize Chinese and Latin text for Unicode FTS while retaining literal source elsewhere. */
export function words(value: string): string[] {
  return [...segmenter.segment(value.normalize('NFKC'))].filter(part => part.isWordLike).map(part => part.segment.toLowerCase())
}

/** Quote query terms as data, never as FTS syntax. */
export function searchExpression(value: string): string {
  return [...new Set(words(value))].slice(0, 24).map(word => `"${word.replaceAll('"', '""')}"`).join(' OR ')
}

/** Split a document into short overlapping Unicode-safe passages. */
export function splitDocument(value: string): string[] {
  const chars = Array.from(value)
  const result: string[] = []
  for (let start = 0; start < chars.length; start += 1000) {
    result.push(chars.slice(start, start + 1200).join(''))
    if (start + 1200 >= chars.length) break
  }
  return result
}

/** Center a bounded original passage on a literal query term instead of truncating the match away. */
export function excerpt(value: string, query: string): string {
  const lower = value.toLowerCase()
  const positions = words(query).map(word => lower.indexOf(word)).filter(index => index >= 0)
  const anchor = positions.length ? Math.min(...positions) : 0
  const start = Math.max(0, anchor - 120)
  return Array.from(value.slice(start)).slice(0, 500).join('')
}
