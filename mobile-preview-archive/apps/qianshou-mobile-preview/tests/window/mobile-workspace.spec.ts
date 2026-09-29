import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PcWindowPort, WindowJournal, WindowJournalStore } from '@deepseek-ai/dsh-client-pc-window-bridge'
import { MobileWorkspace } from '../../src/window/mobile-workspace.ts'
import type { AgentSessionBinding, MobileAgentSessionPort, MobileWorkspaceOptions } from '../../src/window/mobile-workspace-types.ts'
import { startWindowEntry } from '../../src/window/entry.ts'
import { materializeWindow } from '../../src/window/elements.ts'
import type { WindowFrame, WindowNode } from '../../src/window/window.ts'
import { createAccountPcDirectory } from '../../src/window/account-pc-directory.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

function harness() {
  let account: string | null = '42'
  const listeners = new Set<() => void>()
  let id = 0
  let session = 0
  let online = true
  const store = new Map<string, WindowJournal>()
  const journal: WindowJournalStore = {
    load: async binding => store.get(JSON.stringify(binding)) ?? null,
    save: async (value, expected) => {
      const key = JSON.stringify(value.binding)
      if ((store.get(key)?.revision ?? 0) !== expected) throw new Error('conflict')
      store.set(key, structuredClone(value))
    },
    remove: async (binding) => { store.delete(JSON.stringify(binding)) },
  }
  const submissions: string[] = []
  const agent: MobileAgentSessionPort = {
    open: async accountId => ({ accountId, sessionId: SessionId(`cloud-${String(++session)}`) }),
    inspect: async binding => ({ binding, status: 'idle', turns: [{ id: 'a', role: 'assistant', text: `Session ${binding.sessionId}`, at: 0 }] }),
    submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, command) => { submissions.push(`${binding.sessionId}:${command.text}`); return { binding, requestId: command.requestId, state: 'received' } }),
  }
  const pc: PcWindowPort = {
    bootstrap: async (deviceId, _signal, sessionId) => ({ binding: { accountId: '42', pcId: 'pc-a', sourceDeviceId: deviceId, sessionId: SessionId(sessionId ?? 'desktop') }, access: { state: 'online', allowedActions: ['dispatch'] } }),
    access: async () => ({ state: online ? 'online' : 'offline', allowedActions: ['dispatch'] }),
    submit: vi.fn<PcWindowPort['submit']>(async command => ({ requestId: command.requestId, origin: command.origin, revision: 1, state: 'received', childSessionId: command.origin.sessionId, reason: null })),
    sync: async (binding, cursor) => ({ binding, fromCursor: cursor, nextCursor: '1', receipts: [], notReceivedIds: [] }),
    transcript: async binding => ({ binding, status: 'running', turns: [{ id: 'pc', role: 'assistant', text: 'PC specialist working', at: 0 }] }),
  }
  const options: MobileWorkspaceOptions = {
    account: () => account, subscribeAccount: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, deviceId: 'phone', requestId: () => `request-${String(++id)}` as SessionRequestId, now: () => 100, commandTtlMs: 10_000, foregroundRefreshMs: 1000, foregroundRefreshWindowMs: 30_000,
    agent, pcStore: journal, directory: {
      list: async accountId => [{ accountId, pcId: 'pc-a', label: 'Studio PC', platform: 'windows', online }],
      connect: async () => pc,
    },
  }
  return { options, agent, pc, submissions,
    account: (value: string | null) => { account = value; for (const listener of listeners) listener() },
    online: (value: boolean) => { online = value },
  }
}

function plain(node: WindowNode): unknown {
  return { type: node.type, testId: node.testId,
    ...(node.text === undefined ? {} : { text: node.text }), ...(node.value === undefined ? {} : { value: node.value }),
    ...(node.placeholder === undefined ? {} : { placeholder: node.placeholder }),
    ...(node.children === undefined ? {} : { children: node.children.map(plain) }),
  }
}

function node(frame: WindowFrame, testId: string): WindowNode {
  function find(current: WindowNode): WindowNode | undefined {
    return current.testId === testId ? current : current.children?.map(find).find(value => value !== undefined)
  }
  const found = find(frame.tree)
  if (!found) throw new Error(`missing ${testId}`)
  return found
}

describe('mobile agent and account PC workspace', () => {
  it('resumes the newest ready agent session and does not open a replacement', async () => {
    const h = harness()
    const open = vi.fn(h.agent.open)
    const workspace = new MobileWorkspace({
      ...h.options,
      agent: {
        ...h.agent,
        open,
        list: async accountId => [
          { accountId, sessionId: SessionId('older') },
          { accountId, sessionId: SessionId('newer') },
        ],
      },
    })
    await workspace.restoreAgent()
    expect(open).not.toHaveBeenCalled()
    expect(workspace.snapshot().target).toMatchObject({ kind: 'agent', binding: { sessionId: 'newer' } })
    expect(workspace.snapshot().turns.map(turn => turn.text)).toEqual(['Session newer'])
    const empty = new MobileWorkspace({ ...h.options, agent: { ...h.agent, open, list: async () => [] } })
    await empty.restoreAgent()
    expect(empty.snapshot().target).toBeNull()
    const foreign = new MobileWorkspace({
      ...h.options,
      agent: { ...h.agent, open, list: async () => [{ accountId: 'other', sessionId: SessionId('x') }] },
    })
    await foreign.restoreAgent()
    expect(foreign.snapshot().error).toBe('agent-unavailable')
    expect(foreign.snapshot().target).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })

  it('keeps independent agent chat available with zero PCs and snapshots the actual entry frame', async () => {
    const h = harness()
    const frames: WindowFrame[] = []
    const options = { ...h.options, directory: { ...h.options.directory!, list: async () => [] } }
    const entry = startWindowEntry({ platform: 'ios', mobile: options }, (frame) => { frames.push(frame) })
    try {
      await entry.mobile!.refreshDevices()
      await entry.mobile!.openAgent()
      await entry.mobile!.send('给我出图')
      expect(h.submissions).toEqual(['cloud-1:给我出图'])
      const frame = entry.refresh()
      expect(node(frame, 'mobile-pc-directory-state').text).toBe('无远程主机')
      expect(node(frame, 'mobile-request-draft-description').text).toContain('确认')
      expect(plain(frame.tree)).toEqual(JSON.parse(readFileSync(new URL('./expected/mobile-agent-no-pc.json', import.meta.url), 'utf8')))
    } finally { entry.dispose() }
  })

  it('keeps numbered phone slots beside an opened computer session', async () => {
    const h = harness()
    const entry = startWindowEntry({ platform: 'ios', mobile: h.options }, () => {})
    try {
      await entry.mobile!.refreshDevices()
      await entry.mobile!.openAgent()
      await entry.mobile!.openAgent()
      await entry.mobile!.openPc('pc-a')
      const frame = entry.refresh()
      expect(node(frame, 'mobile-sessions-title').text).toBe('手机会话')
      expect(node(frame, 'mobile-conversation-0-label').text).toBe('会话 1')
      expect(node(frame, 'mobile-conversation-1-label').text).toBe('会话 2')
      expect(node(frame, 'mobile-pc-sessions-title').text).toBe('电脑会话')
      expect(node(frame, 'mobile-pc-session-0-label').text).toBe('Studio PC')
      expect(entry.mobile!.snapshot().target).toMatchObject({ kind: 'pc', binding: { pcId: 'pc-a' } })
      node(frame, 'mobile-conversation-0').tap?.()
      expect(entry.mobile!.snapshot().target).toMatchObject({ kind: 'agent', binding: { sessionId: 'cloud-1' } })
      node(frame, 'mobile-pc-session-0').tap?.()
      expect(entry.mobile!.snapshot().target).toMatchObject({ kind: 'pc', binding: { pcId: 'pc-a' } })
    }     finally { entry.dispose() }
  })

  it('reconnects a dropped computer lease and shows only the newest five turns', async () => {
    vi.useFakeTimers()
    const h = harness()
    let opened = 0
    let accessCalls = 0
    const turns = Array.from({ length: 8 }, (_, index) => ({
      id: `t-${String(index)}`, role: index % 2 === 0 ? 'user' as const : 'assistant' as const, text: `消息 ${String(index)}`, at: index,
    }))
    const pc: PcWindowPort = {
      ...h.pc,
      bootstrap: async (deviceId, signal, sessionId) => { opened += 1; return h.pc.bootstrap(deviceId, signal, sessionId) },
      access: async () => {
        accessCalls += 1
        if (accessCalls === 1) throw new Error('PC_RELAY_BOOTSTRAP_REQUIRED')
        return { state: 'online', allowedActions: ['dispatch'] }
      },
      transcript: async binding => ({ binding, status: 'idle', turns }),
    }
    const workspace = new MobileWorkspace({
      ...h.options, now: () => Date.now(), directory: { ...h.options.directory!, connect: async () => pc },
    })
    try {
      await workspace.refreshDevices()
      await workspace.openPc('pc-a')
      expect(opened).toBeGreaterThan(1)
      expect(workspace.snapshot().error).toBeNull()
      expect(workspace.snapshot().turns.map(turn => turn.text)).toEqual(['消息 3', '消息 4', '消息 5', '消息 6', '消息 7'])
      await workspace.send('你好')
      expect(pc.submit).toHaveBeenCalled()
      expect(workspace.snapshot().admissions[0]?.state).not.toBe('queued')
    }     finally { workspace.dispose(); vi.useRealTimers() }
  })

  it('shows a computer message before the PC admits it', async () => {
    const h = harness()
    const gate = deferred<undefined>()
    const pc: PcWindowPort = { ...h.pc, submit: async (command) => { await gate.promise; return h.pc.submit(command) } }
    const workspace = new MobileWorkspace({ ...h.options, directory: { ...h.options.directory!, connect: async () => pc } })
    try {
      await workspace.refreshDevices()
      await workspace.openPc('pc-a')
      const pending = workspace.send('马上显示')
      await vi.waitFor(() => { expect(workspace.snapshot().turns.at(-1)).toMatchObject({ role: 'user', text: '马上显示', pending: true }) })
      gate.resolve(undefined)
      await pending
      expect(workspace.snapshot().turns.at(-1)?.text).toBe('马上显示')
    } finally { workspace.dispose() }
  })

  it('shows the computer transcript when receipt sync fails', async () => {
    const h = harness()
    const turns = Array.from({ length: 6 }, (_, index) => ({
      id: `back-${String(index)}`, role: index % 2 === 0 ? 'user' as const : 'assistant' as const, text: `回复 ${String(index)}`, at: index,
    }))
    const pc: PcWindowPort = {
      ...h.pc,
      sync: async () => { throw new Error('PC_WINDOW_SYNC_FAILED') },
      transcript: async binding => ({ binding, status: 'idle', turns }),
    }
    const workspace = new MobileWorkspace({ ...h.options, directory: { ...h.options.directory!, connect: async () => pc } })
    try {
      await workspace.refreshDevices()
      await workspace.openPc('pc-a')
      expect(workspace.snapshot().error).toBeNull()
      expect(workspace.snapshot().status).toBe('idle')
      expect(workspace.snapshot().turns.map(turn => turn.text)).toEqual(['回复 1', '回复 2', '回复 3', '回复 4', '回复 5'])
    } finally { workspace.dispose() }
  })

  it('shows failed discovery separately from no PC and can still submit to the agent', async () => {
    const h = harness()
    const entry = startWindowEntry({ platform: 'harmony', mobile: { ...h.options, directory: { ...h.options.directory!, list: async () => { throw new Error('unreachable') } } } }, () => {})
    try {
      await entry.mobile!.refreshDevices()
      await entry.mobile!.openAgent()
      await entry.mobile!.send('你好')
      expect(node(entry.refresh(), 'mobile-pc-directory-state').text).toBe('电脑列表查询失败，请重试')
      expect(h.submissions).toEqual(['cloud-1:你好'])
    } finally { entry.dispose() }
  })

  it('leaves absent agent runtime unavailable instead of making an LLM request', async () => {
    const h = harness()
    const { agent: _agent, ...options } = h.options
    const workspace = new MobileWorkspace(options)
    await workspace.openAgent()
    await workspace.send('你好')
    expect(workspace.snapshot()).toMatchObject({ target: null, error: 'agent-unavailable', turns: [] })
    expect(h.submissions).toEqual([])
    workspace.dispose()
  })

  it('binds remote input to the original PC after it goes offline without cloud fallback', async () => {
    const h = harness()
    const workspace = new MobileWorkspace(h.options)
    await workspace.refreshDevices()
    await workspace.openPc('pc-a', 'original')
    expect(workspace.snapshot().turns[0]?.text).toBe('PC specialist working')
    h.online(false)
    await workspace.refreshConversation()
    await workspace.send('继续整理电脑文件')
    expect(workspace.snapshot()).toMatchObject({ target: { kind: 'pc', binding: { pcId: 'pc-a', sessionId: 'original' } }, status: 'offline', admissions: [{ state: 'queued', text: '继续整理电脑文件' }] })
    expect(h.agent.submit).not.toHaveBeenCalled()
    expect(h.pc.submit).not.toHaveBeenCalled()
    h.online(true)
    await workspace.refreshConversation()
    expect(h.pc.submit).toHaveBeenCalledTimes(1)
    expect(workspace.snapshot().admissions[0]?.state).toBe('received')
    workspace.dispose()
  })

  it('hides old account history immediately and ignores late Session opening', async () => {
    const h = harness()
    const pending = deferred<AgentSessionBinding>()
    const workspace = new MobileWorkspace({ ...h.options, agent: { ...h.agent, open: () => pending.promise } })
    const open = workspace.openAgent()
    h.account('77')
    expect(workspace.snapshot()).toMatchObject({ accountId: '77', target: null, devices: [], turns: [] })
    pending.resolve({ accountId: '42', sessionId: SessionId('private') })
    await open
    expect(workspace.snapshot()).toMatchObject({ accountId: '77', target: null, turns: [] })
    workspace.dispose()
  })

  it('serializes one Session while letting another Session continue and isolates late results', async () => {
    const h = harness()
    const wait = deferred<undefined>()
    const submitted: string[] = []
    const agent: MobileAgentSessionPort = { ...h.agent, submit: async (binding, command) => {
      submitted.push(`${binding.sessionId}:${command.text}`)
      if (command.text === 'first') await wait.promise
      return { binding, requestId: command.requestId, state: 'received' }
    } }
    const workspace = new MobileWorkspace({ ...h.options, agent })
    await workspace.openAgent()
    const first = workspace.send('first')
    const second = workspace.send('second')
    await workspace.openAgent()
    await workspace.send('other')
    expect(submitted).toEqual(['cloud-1:first', 'cloud-2:other'])
    wait.resolve(undefined)
    await Promise.all([first, second])
    expect(submitted).toEqual(['cloud-1:first', 'cloud-2:other', 'cloud-1:second'])
    expect(workspace.snapshot().admissions.map(item => item.text)).toEqual(['other'])
    const firstConversation = workspace.snapshot().conversations[0]
    if (firstConversation === undefined) throw new Error('missing conversation')
    workspace.selectConversation(firstConversation)
    expect(workspace.snapshot().admissions.map(item => item.text)).toEqual(['first', 'second'])
    workspace.dispose()
  })

  it('rejects mismatched account directories, PC bindings and agent receipts', async () => {
    const h = harness()
    const workspace = new MobileWorkspace({ ...h.options, directory: { ...h.options.directory!, list: async () => [{ accountId: 'other', pcId: 'pc-a', label: 'private', platform: 'windows', online: true }] } })
    await workspace.refreshDevices()
    expect(workspace.snapshot()).toMatchObject({ directoryState: 'error', devices: [] })
    workspace.dispose()
    const pcWorkspace = new MobileWorkspace({ ...h.options, directory: { ...h.options.directory!, connect: async () => ({ ...h.pc, bootstrap: async () => ({ binding: { accountId: 'other', pcId: 'pc-a', sessionId: SessionId('secret'), sourceDeviceId: 'phone' }, access: { state: 'online', allowedActions: [] } }) }) } })
    await pcWorkspace.refreshDevices()
    await pcWorkspace.openPc('pc-a')
    expect(pcWorkspace.snapshot()).toMatchObject({ target: null, error: 'target-error' })
    pcWorkspace.dispose()
    const receiptWorkspace = new MobileWorkspace({ ...h.options, agent: { ...h.agent, submit: async (binding, command) => ({ binding: { ...binding, accountId: 'other' }, requestId: command.requestId, state: 'received' }) } })
    await receiptWorkspace.openAgent()
    await receiptWorkspace.send('hello')
    expect(receiptWorkspace.snapshot()).toMatchObject({ error: 'send-error', admissions: [{ state: 'uncertain' }] })
    receiptWorkspace.dispose()
  })

  it('connects native tap and input handlers to the real entry consumer', async () => {
    const h = harness()
    const entry = startWindowEntry({ platform: 'android', mobile: h.options }, () => {})
    const props = new Map<string, Readonly<Record<string, unknown>>>()
    const paint = () => materializeWindow<unknown>(entry.refresh().tree, (_type, value) => {
      props.set(value.testId as string, value); return value
    })
    try {
      paint()
      ;(props.get('mobile-new-agent')!.bindtap as () => void)()
      await vi.waitFor(() => { expect(entry.mobile!.snapshot().target?.kind).toBe('agent') })
      paint()
      ;(props.get('mobile-input')!.bindinput as (event: unknown) => void)({ detail: { value: '正常交流' } })
      ;(props.get('mobile-send')!.bindtap as () => void)()
      await vi.waitFor(() => { expect(h.submissions).toEqual(['cloud-1:正常交流']) })
    } finally { entry.dispose() }
  })


  it('deduplicates in-flight native taps by conversation and draft while allowing new drafts and other Sessions', async () => {
    const h = harness()
    const first = deferred<undefined>()
    const submissions: string[] = []
    const entry = startWindowEntry({ platform: 'android', mobile: { ...h.options, agent: { ...h.agent,
      submit: async (binding, command) => {
        submissions.push(`${binding.sessionId}:${command.text}`)
        if (binding.sessionId === 'cloud-1' && command.text === 'first') await first.promise
        return { binding, requestId: command.requestId, state: 'received' }
      },
    } } }, () => {})
    const type = (text: string) => { node(entry.refresh(), 'mobile-input').input!(text) }
    const tap = () => { node(entry.refresh(), 'mobile-send').tap!() }
    try {
      await entry.mobile!.openAgent()
      type('first'); tap(); tap()
      await vi.waitFor(() => { expect(submissions).toEqual(['cloud-1:first']) })
      expect(node(entry.refresh(), 'mobile-input').value).toBe('first')
      type('second'); tap(); tap()
      await entry.mobile!.openAgent()
      type('first'); tap(); tap()
      await vi.waitFor(() => { expect(submissions).toEqual(['cloud-1:first', 'cloud-2:first']) })
      first.resolve(undefined)
      await vi.waitFor(() => { expect(submissions).toEqual(['cloud-1:first', 'cloud-2:first', 'cloud-1:second']) })
      await vi.waitFor(() => { expect(node(entry.refresh(), 'mobile-input').value).toBe('') })
    } finally { first.resolve(undefined); entry.dispose() }
  })

  it('retains input when the native entry cannot record a PC command', async () => {
    const h = harness()
    const entry = startWindowEntry({ platform: 'ios', mobile: { ...h.options, pcStore: { ...h.options.pcStore, save: async () => { throw new Error('disk unavailable') } } } }, () => {})
    try {
      await entry.mobile!.refreshDevices(); await entry.mobile!.openPc('pc-a')
      node(entry.refresh(), 'mobile-input').input!('keep original')
      node(entry.refresh(), 'mobile-send').tap!()
      await vi.waitFor(() => { expect(entry.mobile!.snapshot().error).toBe('send-error') })
      expect(node(entry.refresh(), 'mobile-input').value).toBe('keep original')
      expect(h.pc.submit).not.toHaveBeenCalled()
    } finally { entry.dispose() }
  })

  it('uses authenticated worker facts and requires relay authorization beyond window_origin', async () => {
    const h = harness()
    const row = { id: 'pc-a', owner_id: 42, name: 'PC', status: 'ONLINE', last_seen: '2026-09-19T00:00:00Z', os: 'win32', hostname: null, window_origin: 'https://untrusted.invalid' }
    const authorize = vi.fn(async () => h.pc)
    const directory = createAccountPcDirectory({ account: { listWorkers: async () => [row, { ...row, id: 'linux', os: 'linux' }] }, now: () => Date.parse('2026-09-19T00:00:01Z'), onlineWithinMs: 3000, authorize })
    const pcs = await directory.list('42', new AbortController().signal)
    expect(pcs).toEqual([{ accountId: '42', pcId: 'pc-a', label: 'PC', platform: 'windows', online: true }])
    expect(authorize).not.toHaveBeenCalled()
    const discovered = pcs[0]
    if (discovered === undefined) throw new Error('missing pc')
    await directory.connect(discovered, new AbortController().signal)
    expect(authorize).toHaveBeenCalledWith(row, '42', expect.any(AbortSignal))
    await expect(directory.list('77', new AbortController().signal)).rejects.toThrow('MOBILE_DIRECTORY_ACCOUNT_MISMATCH')
  })

  it('refreshes running agent output in the foreground and stops at completion or background', async () => {
    vi.useFakeTimers()
    const h = harness()
    let running = true
    const inspect = vi.fn<MobileAgentSessionPort['inspect']>(async binding => ({ binding, status: running ? 'running' : 'idle',
      turns: [{ id: 'answer', role: 'assistant', text: running ? 'Working' : 'Finished', at: 0 }],
    }))
    const workspace = new MobileWorkspace({ ...h.options, now: () => Date.now(), agent: { ...h.agent, inspect } })
    try {
      await workspace.openAgent()
      workspace.setForeground(false)
      await vi.advanceTimersByTimeAsync(2000)
      expect(inspect).toHaveBeenCalledTimes(1)
      running = false
      workspace.setForeground(true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(workspace.snapshot().turns[0]?.text).toBe('Finished')
      expect(inspect).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(inspect).toHaveBeenCalledTimes(2)
    } finally { workspace.dispose(); vi.useRealTimers() }
  })

  it('bounds continuous foreground observation and disposes its timers', async () => {
    vi.useFakeTimers()
    const h = harness()
    const inspect = vi.fn<MobileAgentSessionPort['inspect']>(async binding => ({ binding, status: 'running', turns: [] }))
    const workspace = new MobileWorkspace({
      ...h.options, now: () => Date.now(), foregroundRefreshWindowMs: 3000, agent: { ...h.agent, inspect },
    })
    try {
      await workspace.openAgent()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(inspect).toHaveBeenCalledTimes(4)
      workspace.dispose()
      expect(vi.getTimerCount()).toBe(0)
    } finally { workspace.dispose(); vi.useRealTimers() }
  })

  it('inherits request context only from the selected conversation', async () => {
    const h = harness()
    const workspace = new MobileWorkspace(h.options)
    await workspace.openAgent()
    await workspace.send('给我出图，海边日落')
    await workspace.send('再做两张不同风格的')
    expect(workspace.snapshot().draft).toMatchObject({ kind: 'trigger', draft: { inheritedPrompt: '给我出图，海边日落' } })
    await workspace.openAgent()
    await workspace.send('再做两张不同风格的')
    expect(workspace.snapshot().draft?.kind).toBe('suppress')
    expect(h.submissions).toEqual(['cloud-1:给我出图，海边日落', 'cloud-1:再做两张不同风格的', 'cloud-2:再做两张不同风格的'])
    workspace.dispose()
  })

  it('discards late transcript reads after account change and preserves the newest read', async () => {
    const h = harness()
    const old = deferred<Awaited<ReturnType<MobileAgentSessionPort['inspect']>>>()
    let calls = 0
    const workspace = new MobileWorkspace({ ...h.options, agent: { ...h.agent, inspect: async (binding) => {
      calls += 1
      return calls === 2 ? old.promise : { binding, status: 'idle', turns: [{ id: 'a', role: 'assistant', text: String(calls), at: 0 }] }
    } } })
    await workspace.openAgent()
    const oldRead = workspace.refreshConversation()
    await workspace.refreshConversation()
    old.resolve({ binding: { accountId: '42', sessionId: SessionId('cloud-1') }, status: 'idle', turns: [{ id: 'a', role: 'assistant', text: 'old', at: 0 }] })
    await oldRead
    expect(workspace.snapshot().turns[0]?.text).toBe('3')
    h.account(null)
    expect(workspace.snapshot()).toMatchObject({ target: null, turns: [], admissions: [], devices: [] })
    workspace.dispose()
  })


  it('repaints logout from account notifications without a manual entry refresh', async () => {
    const h = harness()
    const frames: WindowFrame[] = []
    const entry = startWindowEntry({ platform: 'android', mobile: h.options }, (frame) => { frames.push(frame) })
    try {
      await entry.mobile!.openAgent()
      h.account(null)
      await Promise.resolve()
      const frame = frames.at(-1)
      if (frame === undefined) throw new Error('missing frame')
      expect(node(frame, 'mobile-transcript').children).toEqual([])
      expect(node(frame, 'mobile-error').text).toBe('请先登录')
    } finally { entry.dispose() }
  })

  it('uses the freshly authorized relay when reopening the same PC Session', async () => {
    const h = harness()
    const nextSubmit = vi.fn<PcWindowPort['submit']>(h.pc.submit)
    let replacement = false
    const workspace = new MobileWorkspace({ ...h.options, directory: {
      ...h.options.directory!, connect: async () => replacement ? { ...h.pc, submit: nextSubmit } : h.pc,
    } })
    await workspace.refreshDevices()
    await workspace.openPc('pc-a', 'desktop')
    replacement = true
    await workspace.openPc('pc-a', 'desktop')
    await workspace.send('新中继')
    expect(nextSubmit).toHaveBeenCalledTimes(1)
    expect(workspace.snapshot().conversations).toHaveLength(1)
    workspace.dispose()
  })

  it('reads an idle conversation again when the user returns to it', async () => {
    const h = harness()
    let text = 'before'
    const workspace = new MobileWorkspace({ ...h.options, agent: { ...h.agent,
      inspect: async binding => ({ binding, status: 'idle', turns: [{ id: 'a', role: 'assistant', text, at: 0 }] }),
    } })
    await workspace.openAgent()
    await workspace.openAgent()
    const first = workspace.snapshot().conversations[0]
    if (first === undefined) throw new Error('missing conversation')
    text = 'updated elsewhere'
    workspace.selectConversation(first)
    await vi.waitFor(() => { expect(workspace.snapshot().turns[0]?.text).toBe('updated elsewhere') })
    workspace.dispose()
  })


  it('keeps following another Session while a previous Session read is still pending', async () => {
    vi.useFakeTimers()
    const h = harness()
    const slow = deferred<Awaited<ReturnType<MobileAgentSessionPort['inspect']>>>()
    let aReads = 0
    let bReads = 0
    const workspace = new MobileWorkspace({ ...h.options, now: () => Date.now(), agent: { ...h.agent, inspect: async (binding) => {
      if (binding.sessionId === 'cloud-1') {
        aReads += 1
        if (aReads > 1) return slow.promise
      } else bReads += 1
      return { binding, status: 'running', turns: [] }
    } } })
    try {
      await workspace.openAgent()
      await vi.advanceTimersByTimeAsync(1000)
      await workspace.openAgent()
      await vi.advanceTimersByTimeAsync(1000)
      expect(bReads).toBe(2)
      slow.resolve({ binding: { accountId: '42', sessionId: SessionId('cloud-1') }, status: 'idle', turns: [] })
      await Promise.resolve()
      expect(workspace.snapshot().target).toMatchObject({ binding: { sessionId: 'cloud-2' } })
    } finally { workspace.dispose(); vi.useRealTimers() }
  })

  it('ignores an old relay access refusal after the same PC has been reauthorized', async () => {
    const h = harness()
    const oldAccess = deferred<Awaited<ReturnType<PcWindowPort['access']>>>()
    let delayed = false
    let replacement = false
    const oldPort: PcWindowPort = { ...h.pc, access: async (...args) => delayed ? oldAccess.promise : h.pc.access(...args) }
    const workspace = new MobileWorkspace({ ...h.options, directory: {
      ...h.options.directory!, connect: async () => replacement ? h.pc : oldPort,
    } })
    await workspace.refreshDevices()
    await workspace.openPc('pc-a')
    delayed = true
    const staleRead = workspace.refreshConversation()
    replacement = true
    await workspace.openPc('pc-a')
    oldAccess.resolve({ state: 'unauthorized', allowedActions: [] })
    await staleRead
    await workspace.send('stay bound')
    expect(h.pc.submit).toHaveBeenCalledTimes(1)
    expect(workspace.snapshot().admissions[0]?.state).toBe('received')
    workspace.dispose()
  })


  it('keeps input ordered while the selected PC is reconnecting', async () => {
    const h = harness()
    const admitted = deferred<Awaited<ReturnType<PcWindowPort['access']>>>()
    let reconnect = false
    const workspace = new MobileWorkspace({ ...h.options, directory: {
      ...h.options.directory!, connect: async () => reconnect ? { ...h.pc, access: async () => admitted.promise } : h.pc,
    } })
    await workspace.refreshDevices()
    await workspace.openPc('pc-a')
    reconnect = true
    const opening = workspace.openPc('pc-a')
    await Promise.resolve()
    await Promise.resolve()
    const sending = workspace.send('during reconnect')
    admitted.resolve({ state: 'online', allowedActions: ['dispatch'] })
    await opening
    expect(await sending).toBe(true)
    expect(h.pc.submit).toHaveBeenCalledTimes(1)
    expect(workspace.snapshot().admissions[0]?.text).toBe('during reconnect')
    workspace.dispose()
  })

  it('hides PC transcript after send-time authorization is revoked', async () => {
    const h = harness()
    let revoked = false
    const workspace = new MobileWorkspace({ ...h.options, directory: {
      ...h.options.directory!, connect: async () => ({ ...h.pc, access: async () => ({ state: revoked ? 'unauthorized' : 'online', allowedActions: ['dispatch'] }) }),
    } })
    await workspace.refreshDevices()
    await workspace.openPc('pc-a')
    expect(workspace.snapshot().turns).toHaveLength(1)
    revoked = true
    await workspace.send('check access')
    expect(workspace.snapshot().turns).toEqual([])
    expect(h.pc.submit).not.toHaveBeenCalled()
    workspace.dispose()
  })


  it('observes an admitted request whose first transcript is still idle', async () => {
    vi.useFakeTimers()
    const h = harness()
    let status: 'idle' | 'running' = 'idle'
    let reply = 'Before admission'
    const workspace = new MobileWorkspace({ ...h.options, now: () => Date.now(), agent: { ...h.agent,
      inspect: async binding => ({ binding, status, turns: [{ id: 'a', role: 'assistant', text: reply, at: 0 }] }),
    } })
    try {
      await workspace.openAgent()
      await workspace.send('start task')
      status = 'running'
      await vi.advanceTimersByTimeAsync(1000)
      expect(workspace.snapshot().status).toBe('running')
      status = 'idle'
      reply = 'Result from agent'
      await vi.advanceTimersByTimeAsync(1000)
      expect(workspace.snapshot().turns[0]?.text).toBe('Result from agent')
      expect(vi.getTimerCount()).toBe(0)
    } finally { workspace.dispose(); vi.useRealTimers() }
  })


  it('starts the observation window when a queued Session input actually reaches admission', async () => {
    vi.useFakeTimers()
    const h = harness()
    const first = deferred<undefined>()
    let status: 'idle' | 'running' = 'idle'
    const workspace = new MobileWorkspace({ ...h.options, now: () => Date.now(), foregroundRefreshWindowMs: 3000, agent: {
      ...h.agent,
      submit: async (binding, command) => {
        if (command.text === 'first') await first.promise
        return { binding, requestId: command.requestId, state: 'received' }
      },
      inspect: async binding => ({ binding, status, turns: [] }),
    } })
    try {
      await workspace.openAgent()
      const sendingFirst = workspace.send('first')
      const sendingSecond = workspace.send('second')
      await vi.advanceTimersByTimeAsync(10_000)
      first.resolve(undefined)
      await Promise.all([sendingFirst, sendingSecond])
      status = 'running'
      await vi.advanceTimersByTimeAsync(1000)
      expect(workspace.snapshot().status).toBe('running')
    } finally { workspace.dispose(); vi.useRealTimers() }
  })

})
