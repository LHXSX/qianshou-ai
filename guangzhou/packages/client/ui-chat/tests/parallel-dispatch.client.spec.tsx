// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import type { ChatSnapshot } from '../src/client/contract/snapshot.ts'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { TURN_PROCESS_INDEPENDENT_KINDS } from '../src/client/contract/turn-process.ts'
import { parallelDispatchDefinition } from '../src/client/conversation-nodes/parallel-dispatch.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { ParallelDispatchNodeView } from '../src/client/chat/ParallelDispatchNodeView.tsx'
import { zh } from '../src/client/locale.ts'

afterEach(cleanup)
const text = '请按我的完整要求核对接口，不要省略细节。'.repeat(8) + '\n最后把测试结果交付给我。'
const receipt = {
  parentSessionId: 'director', childSessionId: 'reviewer', mode: 'continuable',
  messageId: 'message-1', requestId: 'request-1', label: text.slice(0, 96),
  message: { id: 'message-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
}

function event(seq: number, type: string, data: unknown): SessionEventLikeEntry {
  return { type: 'event', event: { seq, time: 1_700_000_000_000 + seq, type, data } as SessionEvent }
}

function assemble(entries: readonly SessionEventLikeEntry[]) {
  const value = new ConversationNodeAssembler({
    entries: (): readonly ConversationNodeDefinition[] => [parallelDispatchDefinition],
    fallbackEntry: () => undefined,
  }, { entries: () => [chatViewDefinition] })
  value.replaceWindow(entries, false)
  value.activateTarget('chat')
  return value
}

function snapshot(value: ConversationNodeAssembler): ChatSnapshot {
  value.flush()
  const current = value.snapshot('chat')
  if (current === undefined) throw new Error('Chat target missing')
  return current as ChatSnapshot
}

function dispatchNode(value: ConversationNodeAssembler): ChatNode<'parallel-dispatch'> {
  const current = snapshot(value)
  const node = current.nodes.get(current.order[0]!)
  if (node?.kind !== 'parallel-dispatch') throw new Error('Dispatch node missing')
  return node as ChatNode<'parallel-dispatch'>
}

function present(node: ChatNode<'parallel-dispatch'>) {
  const openChild = vi.fn()
  const renderMessageImages = vi.fn(() => <span data-test-image />)
  const props = { node, t: makeTranslate(zh, commonZh), renderMessageImages,
    openChild, openFile: vi.fn(), openSkill: vi.fn(),
  } as unknown as ChatNodeViewProps<'parallel-dispatch'> & { openChild: typeof openChild }
  const view = render(<ParallelDispatchNodeView {...props} />)
  return { view, openChild, renderMessageImages }
}

describe('durable human parallel-dispatch transcript', () => {
  it('replays complete original text once in an otherwise empty parent without inventing a turn', () => {
    const entries = [event(1, 'parallel/dispatched', receipt)]
    const live = assemble([])
    live.append(entries[0]!)
    const recovered = assemble(JSON.parse(JSON.stringify(entries)) as SessionEventLikeEntry[])
    expect(snapshot(live).order).toEqual(snapshot(recovered).order)
    expect(snapshot(recovered).order).toHaveLength(1)
    expect(snapshot(recovered).timeline.turnOrder).toEqual([])
    expect(snapshot(recovered).legacy.nodes).toEqual([])
    expect(dispatchNode(recovered).data.receipt.message?.content).toEqual(receipt.message.content)
    expect(dispatchNode(recovered).location).toEqual({ kind: 'session' })
    const { view, openChild } = present(dispatchNode(recovered))
    expect(view.container.querySelectorAll('[data-parallel-dispatch="request-1"]')).toHaveLength(1)
    expect(view.getAllByText(text, { exact: true, normalizer: value => value })).toHaveLength(1)
    expect(openChild).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '查看执行记录' }))
    expect(openChild).toHaveBeenCalledWith({ parentSessionId: 'director', childSessionId: 'reviewer', mode: 'continuable' })
  })

  it('keeps a dispatch outside the running and completed parent turn disclosure', () => {
    const value = assemble([event(1, 'turn/start', { turn: 1 }), event(2, 'step/start', { turn: 1, step: 1 })])
    value.append(event(3, 'parallel/dispatched', receipt))
    const active = dispatchNode(value)
    expect(active.location).toEqual({ kind: 'session' })
    expect(TURN_PROCESS_INDEPENDENT_KINDS.has(active.kind)).toBe(true)
    value.append(event(4, 'step/end', { turn: 1, step: 1 }))
    value.append(event(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    expect(snapshot(value).order).toEqual([active.key])
    expect(dispatchNode(value).visibility).toBe('visible')
    expect(snapshot(value).nodes.processSource(active.key).getSnapshot()).toBeUndefined()
  })

  it('renders accepted image and file references through the shared human message presentation', () => {
    const image = { attachmentId: 'image-1', mediaType: 'image/png', bytes: 4, width: 1, height: 1 }
    const file = { attachmentId: 'file-1', name: 'requirements.md', bytes: 28, mediaType: 'text/markdown' }
    const content = [{ type: 'image', attachment: image }, { type: 'file', attachment: file }, { type: 'text', text: '核对附件中的要求' }]
    const node = dispatchNode(assemble([event(1, 'parallel/dispatched', { ...receipt, message: { ...receipt.message, content } })]))
    const { view, renderMessageImages } = present(node)
    expect(renderMessageImages).toHaveBeenCalledWith({ images: [{ attachment: image }], align: 'end', compact: true })
    expect(view.getByText('requirements.md')).toBeTruthy()
    expect(view.getByText('核对附件中的要求')).toBeTruthy()
    expect({
      kind: node.kind, location: node.location, content: node.data.receipt.message?.content,
      receipt: view.getByText('独立任务已派出').textContent,
      action: view.getByRole('button', { name: '查看执行记录' }).textContent,
    }).toMatchInlineSnapshot(`
      {
        "action": "查看执行记录",
        "content": [
          {
            "attachment": {
              "attachmentId": "image-1",
              "bytes": 4,
              "height": 1,
              "mediaType": "image/png",
              "width": 1,
            },
            "type": "image",
          },
          {
            "attachment": {
              "attachmentId": "file-1",
              "bytes": 28,
              "mediaType": "text/markdown",
              "name": "requirements.md",
            },
            "type": "file",
          },
          {
            "text": "核对附件中的要求",
            "type": "text",
          },
        ],
        "kind": "parallel-dispatch",
        "location": {
          "kind": "session",
        },
        "receipt": "独立任务已派出",
      }
    `)
  })

  it('shows older receipts as summaries without presenting the truncated label as an original message', () => {
    const { message: _message, ...legacy } = receipt
    const node = dispatchNode(assemble([event(1, 'parallel/dispatched', legacy)]))
    const { view } = present(node)
    expect(view.queryByRole('button', { name: '复制' })).toBeNull()
    expect(view.container.querySelector('[data-message-attachments]')).toBeNull()
    expect({ label: node.data.receipt.label, hasOriginalMessage: node.data.receipt.message !== undefined,
      visibleText: view.container.textContent,
    }).toMatchInlineSnapshot(`
      {
        "hasOriginalMessage": false,
        "label": "请按我的完整要求核对接口，不要省略细节。请按我的完整要求核对接口，不要省略细节。请按我的完整要求核对接口，不要省略细节。请按我的完整要求核对接口，不要省略细节。请按我的完整要求核对接口，不要省",
        "visibleText": "↗独立任务已派出历史任务摘要请按我的完整要求核对接口，不要省略细节。请按我的完整要求核对接口，不要省略细节。请按我的完整要求核对接口，不要省略细节。请按我的完整要求核对接口，不要省略细节。请按我的完整要求核对接口，不要省查看执行记录",
      }
    `)
  })
})
