// @vitest-environment jsdom
/** Video URLs preserve Windows paths and use the existing Host byte-range route. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { VideoBody, videoFileUrl } from '../src/client/video/VideoBody.tsx'
import { en } from '../src/client/video/locales.ts'

afterEach(cleanup)

const WIN_PATH = 'C:\\Users\\qianshou\\Downloads\\h3_sample\\out.mp4'
const address = 'dsh-resource://file/session/owner/C%3A/Users/qianshou/Downloads/h3_sample/out.mp4'
const loaded = vi.fn()
const content = { kind: 'renderer', revision: 1, loaded, reload: vi.fn() } as const
const t = (key: keyof typeof en, params?: { name: string }) => params === undefined
  ? en[key] : en[key].replace('{name}', params.name)

function props() {
  const readVideo = vi.fn(async () => ({ ok: true as const, value: {
    absolutePath: WIN_PATH, bytes: 40 * 1024 * 1024, version: 'v1',
  } }))
  return { resourceAddress: address, content, wrap: false, scrollportRef: () => {},
    sessionId: 'owner' as SessionId, useTabInfo: () => ({ tab: { signal: new AbortController().signal } }),
    useResource: () => ({ value: undefined }), readVideo, t } as unknown as React.ComponentProps<typeof VideoBody>
}

describe('videoFileUrl', () => {
  it('uses the authenticated desktop origin and percent-encodes Windows paths', () => {
    const url = videoFileUrl(WIN_PATH, 'dsh-app://app/conversation')
    expect(url).toBeDefined()
    expect(new URL(url!).pathname).toBe('/api/file')
    expect(new URL(url!).searchParams.get('path')).toBe(WIN_PATH)
    expect(videoFileUrl(WIN_PATH, 'dsh-app://shell/update-dialog.html')).toBeUndefined()
  })

  it('rejects relative, external, and control-character paths', () => {
    for (const path of ['out.mp4', 'https://other.example/out.mp4', '//server/share/out.mp4', '\\\\server\\share\\out.mp4', '/tmp/clip\n.mp4']) {
      expect(videoFileUrl(path, 'https://app.example/conversation')).toBeUndefined()
    }
  })
})

describe('VideoBody', () => {
  it('streams a large Windows MP4 via native controls without downloading the complete file', async () => {
    loaded.mockClear()
    const input = props()
    render(<VideoBody {...input} />)
    const video = await screen.findByLabelText('Video preview: out.mp4') as HTMLVideoElement
    expect(input.readVideo).toHaveBeenCalledOnce()
    expect(video.getAttribute('src')).toBe(videoFileUrl(WIN_PATH, window.location.href))
    expect(video.controls).toBe(true)
    expect(video.autoplay).toBe(false)
    expect(video.preload).toBe('metadata')
    fireEvent.loadedMetadata(video)
    expect(loaded).toHaveBeenCalledExactlyOnceWith('v1')
    fireEvent.error(video)
    expect(screen.getByRole('alert').textContent).toBe(en.failed)
  })

  it('aborts a pending Session metadata lookup when the tab closes', () => {
    const input = props()
    const view = render(<VideoBody {...input} />)
    const signal = vi.mocked(input.readVideo).mock.calls[0]?.[1] as AbortSignal
    expect(signal.aborted).toBe(false)
    view.unmount()
    expect(signal.aborted).toBe(true)
  })
})
