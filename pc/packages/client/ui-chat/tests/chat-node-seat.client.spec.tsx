// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { ChatNodeSeat } from '../src/client/chat/ChatNodeSeat.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

const prompt: ChatNode<'system-prompt'> = {
  key: 'request-prompt:1',
  kind: 'system-prompt',
  id: '1',
  target: 'chat',
  anchorSeq: 1,
  location: { kind: 'unresolved' },
  visibility: 'visible',
  data: { text: 'working directory' },
}

function seat(node: ChatNode) {
  const renderSlot = vi.fn(() => null)
  const view = render(<ChatNodeSeat
    nodeKey={node.key}
    useChatNode={() => node}
    useChatNodeProcess={() => undefined}
    historyIncomplete={false}
    compactTranscript={false}
    openSkill={vi.fn()}
    openFile={vi.fn()}
    inspectCall={vi.fn()}
    forkAt={vi.fn()}
    loadImage={vi.fn() as never}
    renderMessageImages={(() => null) as never}
    fileMentions={() => undefined}
    useStore={selector => selector(undefined as never)}
    actions={{ setTurnProcessOpen: vi.fn() } as never}
    renderSlot={renderSlot as never}
    t={((key: string) => key) as never}
  />)
  return { view, renderSlot }
}

describe('ChatNodeSeat system prompt', () => {
  it('keeps the system-prompt row when the client profile is not qianshou', () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    const { view, renderSlot } = seat(prompt)
    expect(view.container.querySelector('[data-chat-flow-kind="system-prompt"]')).not.toBeNull()
    expect(renderSlot).toHaveBeenCalled()
  })

  it('omits the system-prompt row in a qianshou build and still renders other rows', () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
    const hidden = seat(prompt)
    expect(hidden.view.container.querySelector('[data-chat-flow-kind]')).toBeNull()
    expect(hidden.renderSlot).not.toHaveBeenCalled()
    hidden.view.unmount()
    const other = seat({ ...prompt, key: 'user:1', kind: 'user-message' } as ChatNode)
    expect(other.view.container.querySelector('[data-chat-flow-kind="user-message"]')).not.toBeNull()
    expect(other.renderSlot).toHaveBeenCalled()
  })
})
