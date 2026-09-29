// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantMarkdown, localPathMediaUrl, taskMediaReferenceUrl } from '../src/client/chat/AssistantMarkdown.tsx'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../src/client/contract/slots.ts'
import type { AssistantBlock } from '../src/client/contract/snapshot.ts'

afterEach(cleanup)

const t = ((_key: string) => 'label') as unknown as ChatViewSlotProps['t']
const renderMessageImages = (() => null) as unknown as ChatNodeOwnerProps['renderMessageImages']

function textBlock(text: string): AssistantBlock {
  return { kind: 'text', text }
}

const ORIGIN = 'http://127.0.0.1:3080'
const ASSET = 'a'.repeat(64)
const imageRef = `qianshou-media://task/task_123/${ASSET}.png`
const gifRef = `qianshou-media://task/task_123/${ASSET}.gif`
const videoRef = `qianshou-media://task/task_123/${ASSET}.mp4`

describe('localPathMediaUrl', () => {
  it('maps an absolute POSIX path on an HTTP page to the file API', () => {
    expect(localPathMediaUrl('http:', ORIGIN, '/tmp/graph.png'))
      .toBe(`${ORIGIN}/api/file?path=${encodeURIComponent('/tmp/graph.png')}`)
    expect(localPathMediaUrl('https:', 'https://127.0.0.1:3080', '/tmp/graph.png'))
      .toBe(`https://127.0.0.1:3080/api/file?path=${encodeURIComponent('/tmp/graph.png')}`)
  })

  it('maps the owned Electron app page to its forwarded Host file API', () => {
    expect(localPathMediaUrl('dsh-app:', 'null', '/tmp/graph.gif', 'app'))
      .toBe(`dsh-app://app/api/file?path=${encodeURIComponent('/tmp/graph.gif')}`)
    expect(localPathMediaUrl('dsh-app:', 'null', '/tmp/graph.gif', 'shell')).toBeUndefined()
  })

  it('keeps non-HTTP transports inert', () => {
    expect(localPathMediaUrl('file:', 'file:///app', '/tmp/graph.png')).toBeUndefined()
    expect(localPathMediaUrl('ws:', ORIGIN, '/tmp/graph.png')).toBeUndefined()
  })

  it('keeps destinations that cannot be Host-served local files inert', () => {
    expect(localPathMediaUrl('http:', ORIGIN, '')).toBeUndefined()
    expect(localPathMediaUrl('http:', ORIGIN, '//cdn.example.com/x.png')).toBeUndefined()
    expect(localPathMediaUrl('http:', ORIGIN, '\\\\server\\share\\x.png')).toBeUndefined()
    expect(localPathMediaUrl('http:', ORIGIN, 'relative.png')).toBeUndefined()
    expect(localPathMediaUrl('http:', ORIGIN, 'C:tmp\\x.png')).toBeUndefined()
    expect(localPathMediaUrl('http:', ORIGIN, 'C:\\tmp\\x.png'))
      .toBe(`${ORIGIN}/api/file?path=${encodeURIComponent('C:\\tmp\\x.png')}`)
  })

  it('encodes the full path including spaces', () => {
    expect(localPathMediaUrl('http:', ORIGIN, '/tmp/my graph.png'))
      .toBe(`${ORIGIN}/api/file?path=${encodeURIComponent('/tmp/my graph.png')}`)
  })
})

describe('opaque task media references', () => {
  it('maps an admitted task and asset to only the authenticated same-origin read route', () => {
    expect(taskMediaReferenceUrl('http:', ORIGIN, imageRef))
      .toBe(`${ORIGIN}/api/qianshou/result-media?task_id=task_123&asset_id=${ASSET}&type=png`)
    expect(taskMediaReferenceUrl('dsh-app:', 'null', videoRef, 'app'))
      .toBe(`dsh-app://app/api/qianshou/result-media?task_id=task_123&asset_id=${ASSET}&type=mp4`)
  })

  it('rejects forged paths, external URLs, unknown types and unsupported origins', () => {
    for (const ref of [
      `qianshou-media://task/../${ASSET}.png`,
      'qianshou-media://task/task_123/%2e%2e.png',
      `qianshou-media://task/task_123/${ASSET}.svg`,
      `${imageRef}?redirect=https://example.invalid`,
      `https://example.invalid/${ASSET}.png`,
    ]) expect(taskMediaReferenceUrl('http:', ORIGIN, ref)).toBeUndefined()
    expect(taskMediaReferenceUrl('file:', 'null', imageRef)).toBeUndefined()
  })
})

describe('AssistantMarkdown local-path images', () => {
  it('renders a local image path in closing prose through the same-origin API', () => {
    const { container } = render(
      <AssistantMarkdown
        blocks={[textBlock('See ![diagram](/tmp/graph.png) for the layout.')]}
        streaming={false}
        renderMessageImages={renderMessageImages}
        t={t}
      />,
    )
    const image = container.querySelector('img')
    expect(image?.getAttribute('alt')).toBe('diagram')
    const url = new URL(image?.getAttribute('src') ?? '')
    expect(url.pathname).toBe('/api/file')
    expect(url.searchParams.get('path')).toBe('/tmp/graph.png')
  })

  it('renders a completed local video with native playback controls', () => {
    const { container } = render(
      <AssistantMarkdown
        blocks={[textBlock('成片：[播放视频](/tmp/beach-bike.mp4)')]}
        streaming={false}
        renderMessageImages={renderMessageImages}
        t={t}
      />,
    )
    const video = container.querySelector('video')
    expect(video?.hasAttribute('controls')).toBe(true)
    expect(video?.getAttribute('preload')).toBe('none')
    expect(video?.hasAttribute('autoplay')).toBe(false)
    const url = new URL(video?.getAttribute('src') ?? '')
    expect(url.pathname).toBe('/api/file')
    expect(url.searchParams.get('path')).toBe('/tmp/beach-bike.mp4')
  })

  it('renders a Windows H3 MP4 link as video after the assistant turn settles', () => {
    const path = 'C:\\Users\\qianshou\\Downloads\\h3_sample\\out.mp4'
    const { container } = render(<AssistantMarkdown
      blocks={[textBlock(`[播放成片](${encodeURIComponent(path)})`)]}
      streaming={false} renderMessageImages={renderMessageImages} t={t} />)
    const video = container.querySelector('video')
    expect(video?.controls).toBe(true)
    expect(video?.autoplay).toBe(false)
    expect(new URL(video?.getAttribute('src') ?? '').searchParams.get('path')).toBe(path)
  })

  it('renders the private trial attachment link with an encoded durable path', () => {
    const path = '/Users/test/qianshou/attachments/v1/sha256/ab/cd/海边 骑车.mp4'
    const mediaMarkdown = `[播放视频](${encodeURIComponent(path)})`
    const { container, rerender } = render(<AssistantMarkdown
      blocks={[textBlock(`本机私有试用已完成。${mediaMarkdown}`)]}
      streaming={false} renderMessageImages={renderMessageImages} t={t} />)
    const video = container.querySelector('video')
    expect(video?.hasAttribute('controls')).toBe(true)
    expect(new URL(video?.getAttribute('src') ?? '').searchParams.get('path')).toBe(path)
    rerender(<AssistantMarkdown blocks={[textBlock(mediaMarkdown)]}
      streaming={true} renderMessageImages={renderMessageImages} t={t} />)
    expect(container.querySelector('video')).toBeNull()
  })

  it('keeps non-absolute destinations inert', () => {
    const { container } = render(
      <AssistantMarkdown
        blocks={[textBlock('See ![diagram](relative.png).')]}
        streaming={false}
        renderMessageImages={renderMessageImages}
        t={t}
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('diagram')
  })

  it('renders an opaque result image and GIF through the authenticated route', () => {
    const { container } = render(
      <AssistantMarkdown blocks={[textBlock(`![picture](${imageRef})\n\n![animation](${gifRef})`)]}
        streaming={false} renderMessageImages={renderMessageImages} t={t} />,
    )
    const images = [...container.querySelectorAll('img')]
    expect(images.map(image => image.alt)).toEqual(['picture', 'animation'])
    for (const image of images) {
      const src = new URL(image.src)
      expect(src.pathname).toBe('/api/qianshou/result-media')
      expect(src.searchParams.get('asset_id')).toBe(ASSET)
    }
    expect(images.map(image => new URL(image.src).searchParams.get('type'))).toEqual(['png', 'gif'])
  })

  it('renders a result video and a local MP4 with controls without autoplay', () => {
    const { container } = render(
      <AssistantMarkdown blocks={[textBlock(`[result](${videoRef})\n\n[local](/tmp/clip.mp4)`)]}
        streaming={false} renderMessageImages={renderMessageImages} t={t} />,
    )
    const videos = [...container.querySelectorAll('video')]
    expect(videos).toHaveLength(2)
    expect(videos.every(video => video.controls && !video.autoplay && video.preload === 'none')).toBe(true)
    expect(new URL(videos[0]?.src ?? '').pathname).toBe('/api/qianshou/result-media')
    expect(new URL(videos[0]?.src ?? '').searchParams.get('type')).toBe('mp4')
    expect(new URL(videos[1]?.src ?? '').pathname).toBe('/api/file')
  })

  it('does not present untrusted video destinations as media', () => {
    const { container } = render(
      <AssistantMarkdown blocks={[textBlock('[video](https://example.invalid/clip.mp4)\n\n[bad](qianshou-media://task/task_1/not-a-hash.mp4)')]}
        streaming={false} renderMessageImages={renderMessageImages} t={t} />,
    )
    expect(container.querySelector('video')).toBeNull()
  })
})
