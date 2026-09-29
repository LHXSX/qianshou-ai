// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { KeyedSnapshotSelectorHook, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssistantBlock, AssistantMessageNode, ChatSnapshot, ConversationNode,
  ContextMessageNode, PartialAssistant, ToolResultNode, UserMessageNode } from '../src/client/contract/snapshot.ts'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { ChatNodeSeat } from '../src/client/chat/ChatNodeSeat.tsx'
import { qianshouProcessMember } from '../src/client/chat/qianshou-process.ts'
import { createChatStore } from '../src/client/stores.ts'
import { zh } from '../src/client/locale.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

afterEach(() => { cleanup(); vi.unstubAllEnvs(); localStorage.clear() })

function keyedHook<Snapshot>(resolve: (key: string) => ObservableSnapshot<Snapshot>): KeyedSnapshotSelectorHook<Snapshot> {
  const hooks = new WeakMap<object, SnapshotSelectorHook<Snapshot>>()
  function useKey(key: string): Snapshot | undefined
  function useKey<Selected>(key: string, selector: (value: Snapshot | undefined) => Selected,
    equal?: (left: Selected, right: Selected) => boolean): Selected
  function useKey(key: string, selector?: (value: Snapshot | undefined) => unknown,
    equal?: (left: unknown, right: unknown) => boolean): unknown {
    const source = resolve(key)
    let hook = hooks.get(source)
    if (hook === undefined) { hook = bindSnapshotSelector(source); hooks.set(source, hook) }
    return hook(selector ?? (value => value), equal)
  }
  return useKey
}

const user: UserMessageNode & { turn: number } = { kind: 'user', seq: 1, time: 1_000, turn: 1,
  content: [{ type: 'text', text: '请生成演示文稿' }], source: null }
const text = '我正在整理内容，随后生成演示文稿。'
const toolBlock: AssistantBlock = { kind: 'tool-call', callId: 'write-file', name: 'write', argsRaw: '{}' }
const assistant = (seq: number, step: number, blocks: readonly AssistantBlock[]): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn: 1, step, blocks,
})
const tool = (seq: number, callId: string, name = 'write'): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId, call: { name, argsRaw: '{}' },
  callTime: seq * 1_000 - 500, content: [], isError: false, subCalls: [],
})

function body(node: ChatNode | undefined): ReactNode {
  if (node?.kind === 'assistant-step') return node.data.blocks.map((block, index) =>
    block.kind === 'text' ? <p key={index}>{block.text}</p> : null)
  if (node?.kind === 'user' || node?.kind === 'steering' || node?.kind === 'context') return node.data.content.map((block, index) =>
    block.type === 'text' ? <p key={index}>{block.text}</p> : null)
  if (node?.kind === 'tool-call') return <span>{node.data.root.callId}</span>
  if (node?.kind === 'turn-process') return <span>处理过程</span>
  return null
}

/** Production process projection and keyed seats, driven through their observable test sources. */
function harness(input: Parameters<typeof chatSnapshotFixture>[0]) {
  const initial = chatSnapshotFixture(input)
  const source = createSnapshotStore<ChatSnapshot>(initial)
  const useSnapshot = bindSnapshotSelector(source)
  const useChatNode = keyedHook(key => source.getSnapshot().nodes.source(key))
  const useChatNodeProcess = keyedHook(key => source.getSnapshot().nodes.processSource(key))
  const store = createChatStore().create()
  const useStore = bindSnapshotSelector(store)
  const shared = { useChatNode, useChatNodeProcess, historyIncomplete: false, compactTranscript: true,
    openFile: vi.fn(async () => {}), openSkill: vi.fn(), inspectCall: vi.fn(), forkAt: vi.fn(),
    loadImage: vi.fn(async () => { throw new Error('no image read expected') }), renderMessageImages: () => null,
    fileMentions: () => undefined, useStore, actions: store.actions, t: makeTranslate(zh) }
  function Seats() {
    const snapshot = useSnapshot(value => value)
    return snapshot.order.map(key => <ChatNodeSeat key={key} {...shared} nodeKey={key}
      renderSlot={() => body(snapshot.nodes.get(key) as ChatNode | undefined)} />)
  }
  const view = render(<Seats />)
  return { view, store, snapshot: () => source.getSnapshot(), update(next: Parameters<typeof chatSnapshotFixture>[0]) {
    act(() => { source.set(chatSnapshotFixture(next, source.getSnapshot())) })
  } }
}

function row(container: HTMLElement, kind: string, visibleText: string): HTMLElement {
  const result = [...container.querySelectorAll<HTMLElement>(`[data-chat-flow-kind="${kind}"]`)]
    .find(element => element.textContent?.includes(visibleText))
  if (result === undefined) throw new Error(`Missing ${kind} row: ${visibleText}`)
  return result
}

it('keeps streamed Chinese prose visible in the same seat when an ordinary tool block arrives', () => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
  const partial: PartialAssistant = { turn: 1, step: 1, blocks: [{ kind: 'text', text }] }
  const h = harness({ nodes: [user], partial })
  const before = row(h.view.container, 'assistant-step', text)
  expect(before.closest('[hidden]')).toBeNull()
  h.update({ nodes: [user], partial: { ...partial, blocks: [...partial.blocks, toolBlock] } })
  const after = row(h.view.container, 'assistant-step', text)
  expect(after).toBe(before)
  expect(after.closest('[hidden]')).toBeNull()
  expect(row(h.view.container, 'user', '请生成演示文稿').closest('[hidden]')).toBeNull()
})

it('retains settled intermediate prose through tool work and a new answer, then folds it only at turn end', () => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
  const earlier = assistant(2, 1, [{ kind: 'text', text }, toolBlock])
  const h = harness({ nodes: [user, earlier] })
  expect(row(h.view.container, 'assistant-step', text).closest('[hidden]')).toBeNull()
  const working: ConversationNode[] = [user, earlier, tool(3, 'write-file')]
  h.update({ nodes: working })
  expect(row(h.view.container, 'assistant-step', text).closest('[hidden]')).toBeNull()
  expect(row(h.view.container, 'tool-call', 'write-file').closest('[hidden]')).not.toBeNull()
  h.update({ nodes: working, partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text: '正在完成封面' }] } })
  expect(row(h.view.container, 'assistant-step', text).closest('[hidden]')).toBeNull()
  expect(row(h.view.container, 'assistant-step', '正在完成封面').closest('[hidden]')).toBeNull()
  const finished = [...working, assistant(4, 2, [{ kind: 'text', text: '演示文稿已完成，文件在此。' }])]
  h.update({ nodes: finished })
  expect(row(h.view.container, 'assistant-step', text).closest('[hidden]')).toBeNull()
  h.update({ nodes: finished, turnEnds: new Map([[1, 5]]) })
  expect(row(h.view.container, 'assistant-step', text).getAttribute('hidden')).toBe('until-found')
  expect(row(h.view.container, 'assistant-step', '演示文稿已完成，文件在此。').closest('[hidden]')).toBeNull()
  expect(h.view.container.querySelectorAll('[data-chat-flow-kind="turn-process"]')).toHaveLength(1)
  act(() => { h.store.actions.setTurnProcessOpen(1, 2, true) })
  expect(row(h.view.container, 'assistant-step', text).closest('[hidden]')).toBeNull()
})

it('keeps visible prose when the provisional answer becomes process after the next step starts', () => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
  const earlier = assistant(2, 1, [{ kind: 'text', text }])
  const h = harness({ nodes: [user, earlier] })
  const before = row(h.view.container, 'assistant-step', text)
  expect(h.snapshot().nodes.processSource('fixture:assistant:2').getSnapshot()?.spec.answerStep).toBe(1)
  h.update({ nodes: [user, earlier], partial: { turn: 1, step: 2, blocks: [{ kind: 'reasoning', text: '继续执行' }] } })
  expect(h.snapshot().nodes.processSource('fixture:assistant:2').getSnapshot()?.spec.answerStep).toBeNull()
  expect(row(h.view.container, 'assistant-step', text)).toBe(before)
  expect(before.closest('[hidden]')).toBeNull()
})

it('preserves interrupted prose, user interaction, tool failures and deliveries while passive tools remain collapsed', () => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
  const first = assistant(2, 1, [{ kind: 'reasoning', text: 'planning' }])
  const interrupted = { ...assistant(3, 2, [{ kind: 'text', text: '已停止，现有文件仍保留。' }]), interrupted: true as const }
  const failed = { ...tool(5, 'failed'), isError: true }
  const h = harness({ nodes: [user, first, interrupted, tool(4, 'ordinary'), failed,
    tool(6, 'question', 'ask_user'), tool(7, 'quote', 'compute_plan_draft'), tool(8, 'delivery', 'present'),
    assistant(9, 3, [{ kind: 'text', text: '现有成果仍可下载。' }])], turnEnds: new Map([[1, 10]]) })
  expect(row(h.view.container, 'assistant-step', '已停止，现有文件仍保留。').closest('[hidden]')).toBeNull()
  expect(row(h.view.container, 'user', '请生成演示文稿').closest('[hidden]')).toBeNull()
  for (const id of ['failed', 'question', 'quote', 'delivery']) {
    expect(row(h.view.container, 'tool-call', id).closest('[hidden]')).toBeNull()
  }
  expect(row(h.view.container, 'tool-call', 'ordinary').closest('[hidden]')).not.toBeNull()
})

it('retains official live-turn visibility and completed history folding', () => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
  const intermediate = assistant(2, 1, [{ kind: 'text', text }, toolBlock])
  const final = assistant(4, 2, [{ kind: 'text', text: '已完成' }])
  const h = harness({ nodes: [user, intermediate, tool(3, 'ordinary'), final] })
  expect(row(h.view.container, 'assistant-step', text).closest('[hidden]')).toBeNull()
  h.update({ nodes: [user, intermediate, tool(3, 'ordinary'), final], turnEnds: new Map([[1, 5]]) })
  expect(row(h.view.container, 'assistant-step', text).closest('[hidden]')).not.toBeNull()
  expect(row(h.view.container, 'assistant-step', '已完成').closest('[hidden]')).toBeNull()
})

it('still groups reasoning-only rows without hiding live reply content', () => {
  const snapshot = chatSnapshotFixture({ partial: { turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: 'plan' }] } })
  const node = snapshot.nodes.values().find(candidate => candidate.kind === 'assistant-step') as ChatNode | undefined
  if (node === undefined) throw new Error('Missing assistant fixture')
  expect(qianshouProcessMember(node)).toBe(true)
})

it('keeps recall independent of the process group after completion', () => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
  const recall: ContextMessageNode & { turn: number } = { kind: 'context', seq: 2, time: 2_000, turn: 1,
    content: [{ type: 'text', text: '已恢复的历史信息' }], source: null, producer: { role: 'recall', label: null }, form: null }
  const h = harness({ nodes: [user, recall, assistant(3, 1, [{ kind: 'text', text: '结果已完成' }])],
    turnEnds: new Map([[1, 4]]) })
  expect(row(h.view.container, 'context', '已恢复的历史信息').closest('[hidden]')).toBeNull()
})
