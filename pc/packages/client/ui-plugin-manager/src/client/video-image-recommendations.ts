/** Private, filename-based suggestions from a folder the buyer expressly selected. */

const MAX_FOLDER_ENTRIES = 1_000
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_CANDIDATES = 3

export interface VideoImageRecommendation {
  readonly file: File
  readonly matchedKeywords: readonly string[]
}

function keywords(brief: string): readonly string[] {
  const normal = brief.normalize('NFKC').toLocaleLowerCase()
  const words = new Set<string>()
  for (const segment of normal.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(segment)) {
      for (let i = 0; i < segment.length - 1; i += 1) words.add(segment.slice(i, i + 2))
    } else if (segment.length >= 3) words.add(segment)
    if (words.size >= 80) break
  }
  return [...words]
}

/** Recommend real PNG/JPEG files by name or folder keywords; never inspect or upload media bytes.
 * @param files - Browser-granted files from one chosen folder.
 * @param brief - The buyer's current video description and key answers.
 * @returns Up to three bounded files with honest filename-match provenance.
 */
export function recommendVideoImageFiles(files: readonly File[], brief: string): readonly VideoImageRecommendation[] {
  if (files.length > MAX_FOLDER_ENTRIES) throw new Error('VIDEO_IMAGE_FOLDER_TOO_LARGE')
  const terms = keywords(brief)
  const eligible = files.filter(file => ['image/png', 'image/jpeg'].includes(file.type)
    && file.size >= 8 && file.size <= MAX_IMAGE_BYTES)
    .map((file) => {
      const name = file.name.normalize('NFKC').toLocaleLowerCase()
      const folder = file.webkitRelativePath.slice(0, -file.name.length).normalize('NFKC').toLocaleLowerCase()
      const matchedKeywords = terms.filter(term => name.includes(term) || folder.includes(term))
      const score = matchedKeywords.reduce((total, term) => total + (name.includes(term) ? 4 : 1), 0)
      return { file, matchedKeywords, score }
    })
    .sort((a, b) => b.score - a.score || a.file.name.localeCompare(b.file.name)
      || a.file.webkitRelativePath.localeCompare(b.file.webkitRelativePath))
  const selected: VideoImageRecommendation[] = []
  let bytes = 0
  for (const item of eligible) {
    if (selected.length >= MAX_CANDIDATES) break
    if (bytes + item.file.size > MAX_IMAGE_BYTES) continue
    selected.push({ file: item.file, matchedKeywords: item.matchedKeywords })
    bytes += item.file.size
  }
  return selected
}
