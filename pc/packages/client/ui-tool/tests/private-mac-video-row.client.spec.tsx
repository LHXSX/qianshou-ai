// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PrivateMacVideoRow, privateMacVideoPath } from '../src/client/tool/toolviews/private-mac-video-row.tsx'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import { en, zh } from '../../ui-conversation/src/client/locales.ts'

afterEach(cleanup)
const digest = 'a'.repeat(64)
const path = `/Users/test/Library/Application Support/qianshou/attachments/v1/files/aa/${digest}/drawn-video-5s.mp4`
const meta = { kind: 'qianshou.private-mac-video-result.v1', status: 'completed',
  scope: 'private-local-trial', marketInstalled: false, dispatchable: false, charged: false,
  durationSeconds: 5, bytes: 515941, attachmentId: `sha256:${digest}`,
  mediaMarkdown: `[播放视频](${encodeURIComponent(path)})` }
const block = { kind: 'tool-result', seq: 5, time: 5, callId: 'call-1',
  call: { name: 'plugin_drawn_video_try_local', argsRaw: '{"title":"海边骑车"}' },
  callTime: 1, content: [{ type: 'text', text: '{"status":"completed","attachmentId":"sha256:..."}' }],
  isError: false, meta, subCalls: [] } as unknown as ToolCallBlock

describe('private Mac video tool result card', () => {
  it('uses the active conversation locale for the trial heading and player label', () => {
    for (const dictionary of [zh, en]) {
      const { getByText, getByLabelText, unmount } = render(<PrivateMacVideoRow
        toolName="plugin_drawn_video_try_local" block={block}
        t={((key: keyof typeof zh) => dictionary[key]) as never} />)
      expect(getByText(dictionary['tool.privateMacVideo.title'])).toBeTruthy()
      expect(getByText(dictionary['tool.privateMacVideo.heading'])).toBeTruthy()
      expect(getByText(dictionary['tool.privateMacVideo.scope'])).toBeTruthy()
      expect(getByLabelText(dictionary['tool.privateMacVideo.videoAria'])).toBeTruthy()
      unmount()
    }
  })

  it('shows a native player from UI-only result metadata without model-visible path', () => {
    expect(privateMacVideoPath(block)).toBe(path)
    const { container } = render(<PrivateMacVideoRow
      toolName="plugin_drawn_video_try_local" block={block}
      t={((_key: string) => 'label') as never} />)
    const player = container.querySelector('video')
    expect(player?.hasAttribute('controls')).toBe(true)
    expect(player?.getAttribute('preload')).toBe('metadata')
    expect(new URL(player?.getAttribute('src') ?? '').searchParams.get('path')).toBe(path)
  })

  it('does not play refused, mismatched, or forged result metadata', () => {
    expect(privateMacVideoPath({ ...block, isError: true } as ToolCallBlock)).toBeNull()
    expect(privateMacVideoPath({ ...block, meta: { ...meta, attachmentId: `sha256:${'b'.repeat(64)}` } } as ToolCallBlock)).toBeNull()
    expect(privateMacVideoPath({ ...block, meta: { ...meta, marketInstalled: true } } as ToolCallBlock)).toBeNull()
    expect(privateMacVideoPath({ ...block, meta: { ...meta, mediaMarkdown: '[播放视频](https://evil.example/video.mp4)' } } as ToolCallBlock)).toBeNull()
  })
})
