/** Browser-owned originals; selectors never authorize reading another Session's image. */
import type { ImageSourceRef } from '@deepseek-ai/dsh-client-compute-trigger'

export interface ImageSource {
  readonly ref: ImageSourceRef
  readonly name: string
  readonly url: string
  readonly file?: File
  readonly dataUri?: string
}

export function sameImageSource(left: ImageSourceRef, right: ImageSourceRef): boolean {
  return left.kind === 'attachment' && right.kind === 'attachment'
    ? left.id === right.id
    : left.kind === 'result' && right.kind === 'result' && left.turnId === right.turnId && left.imageIndex === right.imageIndex
}

/** Only image bytes already selected from the current conversation can leave the browser. */
export async function imageSourceDataUri(source: ImageSource): Promise<string> {
  if (source.dataUri !== undefined) return source.dataUri
  if (source.file === undefined) throw new Error('原图已失效，请重新上传。')
  const file = source.file
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => { reject(new Error('图片读取失败，请重新上传。')) }
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.startsWith('data:image/')) {
        reject(new Error('无法读取这张图片，请换一张再试。'))
      } else resolve(reader.result)
    }
    reader.readAsDataURL(file)
  })
}
