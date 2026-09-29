// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PresentedMediaPreview, presentedMediaSource } from '../src/client/PresentedMediaPreview.tsx'

afterEach(cleanup)

const ORIGIN = 'http://127.0.0.1:19387'
const WEB_PAGE = `${ORIGIN}/conversation`
const DESKTOP_PAGE = 'dsh-app://app/conversation'
const coordinates = { sessionId: 'owner', seq: 7, index: 0 }

describe('presentedMediaSource', () => {
  it('resolves an explicitly delivered relative GIF under the owning workspace', () => {
    expect(presentedMediaSource('out/海边 动图.gif', coordinates, WEB_PAGE)).toEqual({
      kind: 'image',
      url: `${ORIGIN}/api/present.preview?sessionId=owner&seq=7&index=0`,
    })
  })

  it('keeps an absolute video path and never builds a third-party URL', () => {
    expect(presentedMediaSource('/tmp/render.mp4', coordinates, WEB_PAGE)).toEqual({
      kind: 'video', url: `${ORIGIN}/api/present.preview?sessionId=owner&seq=7&index=0`,
    })
    expect(presentedMediaSource('https://example.com/tracker.mp4', coordinates, WEB_PAGE)).toBeNull()
  })

  it('uses the owned Electron app scheme instead of the opaque custom-scheme origin', () => {
    expect(new URL(DESKTOP_PAGE).origin).toBe('null')
    expect(presentedMediaSource('out/片段.mp4', coordinates, DESKTOP_PAGE)).toEqual({
      kind: 'video',
      url: 'dsh-app://app/api/present.preview?sessionId=owner&seq=7&index=0',
    })
    for (const page of ['dsh-app://shell/', 'dsh-app://app.evil/', 'dsh-app://user@app/', 'dsh-app://app:88/']) {
      expect(presentedMediaSource('/tmp/render.mp4', coordinates, page)).toBeNull()
    }
  })

  it('does not request invalid receipt coordinates or render active content', () => {
    expect(presentedMediaSource('out/result.png', { ...coordinates, sessionId: '' }, WEB_PAGE)).toBeNull()
    for (const path of ['/tmp/page.html', '/tmp/vector.svg', '/tmp/vector.svgz', '/tmp/script.js']) {
      expect(presentedMediaSource(path, coordinates, WEB_PAGE)).toBeNull()
    }
    expect(presentedMediaSource('/tmp/result.gif', coordinates, 'file:///app/index.html')).toBeNull()
  })

  it('limits previews to raster images and browser video formats', () => {
    for (const extension of ['PNG', 'apng', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp']) {
      expect(presentedMediaSource(`/tmp/result.${extension}`, coordinates, WEB_PAGE)?.kind).toBe('image')
    }
    for (const extension of ['mp4', 'm4v', 'webm', 'ogv', 'mov']) {
      expect(presentedMediaSource(`/tmp/result.${extension}`, coordinates, WEB_PAGE)?.kind).toBe('video')
    }
    for (const extension of ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba']) {
      expect(presentedMediaSource(`/tmp/result.${extension}`, coordinates, WEB_PAGE)).toBeNull()
    }
  })
})

describe('PresentedMediaPreview', () => {
  it('shows a GIF directly and drops a failed preview without a broken image', () => {
    const source = presentedMediaSource('/tmp/animated.gif', coordinates, WEB_PAGE)!
    const view = render(<PresentedMediaPreview source={source} path="/tmp/animated.gif" />)
    const image = view.getByRole('img', { name: 'animated.gif' })
    expect(image.getAttribute('src')).toBe(source.url)
    fireEvent.error(image)
    expect(view.queryByRole('img')).toBeNull()
  })

  it('shows a video with explicit controls and no automatic playback', () => {
    const source = presentedMediaSource('/tmp/render.mp4', coordinates, WEB_PAGE)!
    const view = render(<PresentedMediaPreview source={source} path="/tmp/render.mp4" />)
    const video = view.getByLabelText('render.mp4') as HTMLVideoElement
    expect(video.getAttribute('src')).toBe(source.url)
    expect(video.hasAttribute('controls')).toBe(true)
    expect(video.getAttribute('preload')).toBe('metadata')
    expect(video.hasAttribute('autoplay')).toBe(false)
    fireEvent.error(video)
    expect(view.queryByLabelText('render.mp4')).toBeNull()
  })

})
