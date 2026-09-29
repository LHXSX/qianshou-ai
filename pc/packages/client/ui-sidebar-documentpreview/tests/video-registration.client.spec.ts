/** Video files use a ranged-media renderer instead of the unsupported binary state. */
import { describe, expect, it, vi } from 'vitest'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { VIDEO_BODY_ID, VIDEO_EXTENSIONS, videoBodyDefinition } from '../src/client/video/index.ts'

describe('video registration', () => {
  it('claims Windows and POSIX video paths without complete-byte loading or text fallback', () => {
    const title = vi.fn(() => '视频')
    const definition = videoBodyDefinition(title)
    expect(definition).toMatchObject({ id: VIDEO_BODY_ID, extensions: VIDEO_EXTENSIONS,
      binaryExtensions: VIDEO_EXTENSIONS, priority: 'builtin', loading: 'renderer', wrap: false })
    const registry = new DocumentPreviewRegistry()
    registry.register(definition)
    expect(registry.candidates('C:\\Users\\qianshou\\Downloads\\h3_sample.mp4'))
      .toEqual([definition])
    expect(registry.candidates('/tmp/clip.webm')).toEqual([definition])
    expect(title).not.toHaveBeenCalled()
  })
})
