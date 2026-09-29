// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { recommendVideoImageFiles } from '../src/client/video-image-recommendations.ts'

function image(name: string, path = `相册/${name}`, bytes = 20): File {
  const file = new File([new Uint8Array(bytes)], name, { type: 'image/png' })
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

it('ranks real folder images by the buyer brief without reading or uploading their bytes', () => {
  const photos = [image('城市.png'), image('海边小狗.png'), image('草地.png'), image('海边日落.png')]
  const ranked = recommendVideoImageFiles(photos, '海边的小狗奔跑')
  expect(ranked.slice(0, 2).map(item => item.file.name)).toEqual(['海边小狗.png', '海边日落.png'])
  expect(ranked).toHaveLength(3)
  expect(ranked[0]?.matchedKeywords).toContain('小狗')
})

it('uses folder names, limits bytes, and rejects an unbounded folder', () => {
  const folder = [image('a.png', '海边/a.png', 9 * 1024 * 1024),
    image('b.png', '海边/b.png', 9 * 1024 * 1024), image('c.png', '海边/c.png', 10)]
  const ranked = recommendVideoImageFiles(folder, '海边')
  expect(ranked.map(item => item.file.name)).toEqual(['a.png', 'c.png'])
  expect(ranked[0]?.matchedKeywords).toContain('海边')
  expect(() => recommendVideoImageFiles(Array.from({ length: 1_001 }, () => image('a.png')), '海边'))
    .toThrow('VIDEO_IMAGE_FOLDER_TOO_LARGE')
})
