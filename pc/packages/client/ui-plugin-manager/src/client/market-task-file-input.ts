/** Display admission for the current file form; final content verification remains server-owned. */
export interface MarketTaskFileInput {
  accept: string
  hint: string
  supports(filename: string): boolean
}

const videoExtensions = ['mp4', 'mov', 'mkv', 'avi', 'flv', 'webm', 'ts', 'm4v']
const legalExtensions = ['txt', 'md', 'pdf', 'docx']

/** Exact shipped executor formats, independent of product names, categories or task text. */
export function marketTaskFileInput(taskType: string): MarketTaskFileInput | null {
  const extensions = taskType === 'video_thumbnail' || taskType === 'media.thumbnail' ? videoExtensions
    : taskType === 'legal_doc_bundle_v1' ? legalExtensions : null
  if (extensions === null) return null
  return {
    accept: extensions.map(value => `.${value}`).join(','),
    hint: taskType === 'legal_doc_bundle_v1' ? '支持文字、PDF 和 Word；最多 15 个文件，合计 16 MiB。'
      : '请上传视频（MP4、MOV、MKV 等）；图片不能用于视频抽帧。ZIP 请先解压后选择视频。最多 15 个文件，合计 16 MiB。',
    supports(filename) { return extensions.some(value => filename.toLowerCase().endsWith(`.${value}`)) },
  }
}
