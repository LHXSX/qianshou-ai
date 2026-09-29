// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'
import type { MarkdownMediaLinks, MarkdownPathImages } from '../src/markdown/MarkdownText.tsx'

afterEach(cleanup)

const LOCAL_IMAGE = '![diagram](/tmp/graph.png)'

const mapping = (value: string): string | undefined =>
  value === '/tmp/graph.png' ? 'https://cdn.example.com/graph.png' : undefined

describe('MarkdownText local-path images', () => {
  it('renders authored alt text when no path vocabulary exists', () => {
    const { container } = render(<MarkdownText text={LOCAL_IMAGE} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('diagram')).toBeTruthy()
  })

  it('rewrites a local image path through the vocabulary', () => {
    const pathImages: MarkdownPathImages = { resolve: mapping }
    const { container } = render(<MarkdownText text={LOCAL_IMAGE} pathImages={pathImages} />)
    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('https://cdn.example.com/graph.png')
    expect(image?.getAttribute('alt')).toBe('diagram')
  })

  it('decodes an authored filename before resolving a local image', () => {
    const pathImages: MarkdownPathImages = { resolve: value => value === '/tmp/my graph.png'
      ? 'dsh-app://app/api/file?path=%2Ftmp%2Fmy%20graph.png' : undefined }
    const { container } = render(<MarkdownText text="![graph](/tmp/my%20graph.png)" pathImages={pathImages} />)
    expect(container.querySelector('img')?.getAttribute('src'))
      .toBe('dsh-app://app/api/file?path=%2Ftmp%2Fmy%20graph.png')
  })

  it.each(['diagram', ''])('shows authored text after an image fails with alt %j', (alt) => {
    const pathImages: MarkdownPathImages = { resolve: mapping }
    const { container } = render(
      <MarkdownText text={`![${alt}](/tmp/graph.png)`} pathImages={pathImages} />,
    )
    fireEvent.error(screen.getByAltText(alt))
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe(alt || '/tmp/graph.png')
  })

  it('loads a replacement destination after the preceding image failed', () => {
    const pathImages: MarkdownPathImages = { resolve: value => `https://example.com${value}` }
    const { container, rerender } = render(
      <MarkdownText text={LOCAL_IMAGE} pathImages={pathImages} />,
    )
    fireEvent.error(screen.getByRole('img'))
    rerender(<MarkdownText text="![](/tmp/replacement.png)" pathImages={pathImages} />)
    expect(container.querySelector('img')?.getAttribute('src'))
      .toBe('https://example.com/tmp/replacement.png')
  })

  it('keeps the alt fallback when the vocabulary misses', () => {
    const pathImages: MarkdownPathImages = { resolve: () => undefined }
    const { container } = render(<MarkdownText text={LOCAL_IMAGE} pathImages={pathImages} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('diagram')).toBeTruthy()
  })

  it('accepts data and blob vocabulary results', () => {
    const data: MarkdownPathImages = { resolve: () => 'data:image/png;base64,AAAA' }
    const blob: MarkdownPathImages = { resolve: () => 'blob:https://example.com/id' }
    const dataRender = render(<MarkdownText text={LOCAL_IMAGE} pathImages={data} />)
    const blobRender = render(<MarkdownText text={LOCAL_IMAGE} pathImages={blob} />)
    expect(dataRender.container.querySelector('img')?.getAttribute('src'))
      .toBe('data:image/png;base64,AAAA')
    expect(blobRender.container.querySelector('img')?.getAttribute('src'))
      .toBe('blob:https://example.com/id')
  })

  it('admits only the owned Electron app media routes', () => {
    const accepted: MarkdownPathImages = { resolve: () => 'dsh-app://app/api/qianshou/result-media?task_id=t&asset_id=a' }
    const image = render(<MarkdownText text={LOCAL_IMAGE} pathImages={accepted} />)
    expect(image.container.querySelector('img')?.getAttribute('src'))
      .toBe('dsh-app://app/api/qianshou/result-media?task_id=t&asset_id=a')
    image.unmount()
    for (const source of ['dsh-app://other/api/file?path=x', 'dsh-app://app/other?path=x']) {
      const rejected: MarkdownPathImages = { resolve: () => source }
      const view = render(<MarkdownText text={LOCAL_IMAGE} pathImages={rejected} />)
      expect(view.container.querySelector('img')).toBeNull()
      view.unmount()
    }
  })

  it('rejects non-absolute vocabulary results', () => {
    for (const result of ['relative.png', '/api/image?path=%2Ftmp%2Fx.png', 'ftp://host/x.png']) {
      const pathImages: MarkdownPathImages = { resolve: () => result }
      const { container, unmount } = render(<MarkdownText text={LOCAL_IMAGE} pathImages={pathImages} />)
      expect(container.querySelector('img')).toBeNull()
      unmount()
    }
  })

  it('leaves remote images untouched even when the vocabulary maps them', () => {
    const remote = '![remote](https://example.com/a.png)'
    const pathImages: MarkdownPathImages = { resolve: () => 'https://cdn.example.com/b.png' }
    const { container } = render(<MarkdownText text={remote} pathImages={pathImages} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png')
  })

  it('rewrites reference-style local image destinations', () => {
    const reference = ['![diagram][fig]', '', '[fig]: /tmp/graph.png'].join('\n')
    const pathImages: MarkdownPathImages = { resolve: mapping }
    const { container } = render(<MarkdownText text={reference} pathImages={pathImages} />)
    expect(container.querySelector('img')?.getAttribute('src'))
      .toBe('https://cdn.example.com/graph.png')
  })

  it('applies the vocabulary only to settled renders, never while streaming', () => {
    const pathImages: MarkdownPathImages = { resolve: mapping }
    const { container, rerender } = render(
      <MarkdownText text={LOCAL_IMAGE} streaming pathImages={pathImages} />,
    )
    // Streaming messages may still grow, so their prose keeps the inert alt
    // fallback until the settled pass self-heals it.
    expect(container.querySelector('img')).toBeNull()
    rerender(<MarkdownText text={LOCAL_IMAGE} pathImages={pathImages} />)
    expect(container.querySelector('img')?.getAttribute('src'))
      .toBe('https://cdn.example.com/graph.png')
  })
})

describe('MarkdownText owner-vouched videos', () => {
  const mediaLinks: MarkdownMediaLinks = { resolve: value => value === '/tmp/clip.mp4'
    ? { kind: 'video', src: 'https://example.com/api/file?path=%2Ftmp%2Fclip.mp4' } : undefined }

  it('embeds a local video link, image-style video reference and exact inline code path', () => {
    for (const text of ['[播放](/tmp/clip.mp4)', '![视频](/tmp/clip.mp4)', '`/tmp/clip.mp4`']) {
      const { container, unmount } = render(<MarkdownText text={text} mediaLinks={mediaLinks} />)
      const video = container.querySelector('video')
      expect(video?.getAttribute('src')).toBe('https://example.com/api/file?path=%2Ftmp%2Fclip.mp4')
      expect(video?.hasAttribute('controls')).toBe(true)
      unmount()
    }
  })

  it('retries a changed video destination after a prior playback error', () => {
    const videos: MarkdownMediaLinks = { resolve: value => ({ kind: 'video',
      src: `https://example.com/api/file?path=${encodeURIComponent(value)}` }) }
    const { container, rerender } = render(<MarkdownText text="[播放](/tmp/old.mp4)" mediaLinks={videos} />)
    fireEvent.error(container.querySelector('video')!)
    expect(container.querySelector('video')).toBeNull()
    rerender(<MarkdownText text="[播放](/tmp/new.mp4)" mediaLinks={videos} />)
    expect(container.querySelector('video')?.getAttribute('src'))
      .toBe('https://example.com/api/file?path=%2Ftmp%2Fnew.mp4')
  })

  it('keeps an unvouched local link inert and never embeds a streaming path', () => {
    const { container, rerender } = render(<MarkdownText text="[播放](/tmp/clip.mp4)" />)
    expect(container.querySelector('video')).toBeNull()
    rerender(<MarkdownText text="[播放](/tmp/clip.mp4)" mediaLinks={mediaLinks} streaming />)
    expect(container.querySelector('video')).toBeNull()
  })

  it('rejects non-media and non-app custom protocol targets', () => {
    const forged: MarkdownMediaLinks = { resolve: () => ({ kind: 'video', src: 'dsh-app://shell/api/file?path=%2Ftmp%2Fclip.mp4' }) }
    const { container } = render(<MarkdownText text="[播放](/tmp/clip.mp4)" mediaLinks={forged} />)
    expect(container.querySelector('video')).toBeNull()
  })
})
