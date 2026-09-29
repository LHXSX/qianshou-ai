/**
 * 手机端对话控制器的行为测试。
 *
 * 这一份锁的是「接上真实模型之后界面必须表现出的行为」，而不是实现细节：
 * 模型清单来自设置而不是写死的假数据、没配密钥时给出可操作的引导而不是静默失败、
 * 流式增量被逐字追加、按「停止」是安静结束而不是报错、保存后能原样读回。
 *
 * `streamChat` 在这里被替换成假的：真实 SSE 解析、状态码分类与真实 HTTP 往返
 * 已经由 `llm.spec.ts`（内联服务端）和 `integration.spec.ts`（仓库里的 mock 服务端）
 * 在真实 socket 上验证。这里关心的是控制器怎么消费那些回调，用假流可以把
 * 「增量边界」「中止时机」这两件在真实网络上无法稳定复现的事做成确定性断言。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatController, SYSTEM_PROMPT, groupRuns, failureCopy } from '../src/chat.ts'
import { ChatFailure, FAILURE_COPY, MODEL_BRAND, PROVIDER_TEMPLATES, type ChatMessage, type SendOptions, type StreamHandlers } from '../src/llm.ts'
import { loadSecret, loadSettings, type StoredSession } from '../src/store.ts'

/** 一个最小可用的 localStorage 替身；只实现被用到的三个方法。 */
function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const map = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  })
  return map
}

/** 一次假流的观测结果。 */
interface FakeStream {
  readonly send: (options: SendOptions, handlers: StreamHandlers) => { abort: () => void; completed: Promise<void> }
  readonly calls: SendOptions[]
  readonly handlers: StreamHandlers[]
  readonly aborted: () => number
}

/** 受控假流：回调在测试希望的时刻被调用，没有网络也没有定时器。 */
function fakeStream(): FakeStream {
  const calls: SendOptions[] = []
  const handlers: StreamHandlers[] = []
  let aborts = 0
  return {
    calls,
    handlers,
    aborted: () => aborts,
    send: (options, hooks) => {
      calls.push(options)
      handlers.push(hooks)
      return { abort: () => { aborts += 1 }, completed: Promise.resolve() }
    },
  }
}

/** 取出最后一次调用的回调；没有调用时直接失败，避免断言静默通过。 */
function lastHandlers(stream: FakeStream): StreamHandlers {
  const found = stream.handlers[stream.handlers.length - 1]
  if (found === undefined) throw new Error('还没有发起过流')
  return found
}

/** 会话里每条消息的「角色 + 正文」；时间戳在专门的用例里单独验证，不混进行为断言。 */
function shape(controller: ChatController): Array<{ role: string; content: string }> {
  return controller.snapshot().messages.map(({ role, content }) => ({ role, content }))
}

/** 取当前状态里最后一条助手消息的文本。 */
function answerText(controller: ChatController): string {
  const messages = controller.snapshot().messages
  const last = messages[messages.length - 1]
  return last?.role === 'assistant' ? last.content : ''
}

const READY = { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }

afterEach(() => { vi.unstubAllGlobals() })

describe('模型清单来自设置，而不是写死的假数据', () => {
  it('DeepSeek 设置给出模板里的真实模型名与 id', () => {
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: fakeStream().send })
    const ids = controller.modelOptions().map(option => option.id)
    expect(ids).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(controller.modelLabel()).toBe(MODEL_BRAND)
  })

  it('任何一种设置下都不会出现写死的三方模型名', () => {
    for (const providerId of Object.keys(PROVIDER_TEMPLATES)) {
      const template = PROVIDER_TEMPLATES[providerId]!
      const controller = new ChatController({
        settings: { providerId, baseUrl: template.baseUrl, model: template.defaultModel },
        secret: 'sk-x',
        sessions: [],
        stream: fakeStream().send,
      })
      const shown = controller.modelOptions().map(option => option.name).join(' ')
      expect(shown).not.toMatch(/GPT-4o|DeepSeek-V3|Qwen/)
    }
  })

  it('模板没有模型清单时，用配置里填的模型；没填就一个都不显示', () => {
    const named = new ChatController({
      settings: { providerId: 'custom', baseUrl: 'https://my.gateway/v1', model: 'my-model' },
      secret: 'sk-x', sessions: [], stream: fakeStream().send,
    })
    expect(named.modelOptions().map(option => option.id)).toEqual(['my-model'])
    expect(named.modelLabel()).toBe('my-model')

    const blank = new ChatController({
      settings: { providerId: 'custom', baseUrl: 'https://my.gateway/v1', model: '  ' },
      secret: 'sk-x', sessions: [], stream: fakeStream().send,
    })
    expect(blank.modelOptions()).toEqual([])
  })

  it('用户手填的模型不在模板里时也保留，界面不会显示成另一个模型', () => {
    const controller = new ChatController({
      settings: { ...READY, model: 'deepseek-chat-latest' },
      secret: 'sk-x', sessions: [], stream: fakeStream().send,
    })
    expect(controller.modelOptions().map(option => option.id)).toContain('deepseek-chat-latest')
    expect(controller.modelLabel()).toBe('deepseek-chat-latest')
  })
})

describe('未配置密钥时给出引导，而不是静默失败', () => {
  it('没有密钥时发送被拦下，提示文案指向设置页', () => {
    const stream = fakeStream()
    const controller = new ChatController({ settings: READY, secret: '', sessions: [], stream: stream.send })

    expect(controller.send('你好')).toBe(false)
    const failure = controller.snapshot().failure
    expect(failure?.kind).toBe('no-key')
    expect(failure?.message).toBe(FAILURE_COPY['no-key'])
    expect(failure?.message).toContain('模型设置')
    // 根本没发出请求，也没留下半条消息
    expect(stream.calls).toHaveLength(0)
    expect(shape(controller)).toEqual([])
  })

  it('只有空白的密钥同样算未配置', () => {
    const controller = new ChatController({ settings: READY, secret: '   ', sessions: [], stream: fakeStream().send })
    controller.send('你好')
    expect(controller.snapshot().failure?.kind).toBe('no-key')
  })

  it('没有服务地址时提示的是地址，不是密钥', () => {
    const controller = new ChatController({
      settings: { ...READY, baseUrl: '' }, secret: 'sk-x', sessions: [], stream: fakeStream().send,
    })
    controller.send('你好')
    expect(controller.snapshot().failure?.kind).toBe('no-endpoint')
  })

  it('配好之后同一次发送就能过，并且失败提示被清掉', () => {
    // 这条要真的落一次密钥，所以必须自己装存储桩：早先它靠别的文件遗留下来的全局
    // `localStorage` 才跑得通，一旦执行顺序变了就地失败——用例不能依赖邻居。
    installStorage()
    const stream = fakeStream()
    const controller = new ChatController({ settings: READY, secret: '', sessions: [], stream: stream.send })
    controller.send('你好')
    expect(controller.snapshot().failure).not.toBeNull()

    controller.saveConnection(READY, 'sk-real')
    expect(controller.hasKey()).toBe(true)
    expect(controller.send('你好')).toBe(true)
    expect(controller.snapshot().failure).toBeNull()
    expect(stream.calls).toHaveLength(1)
  })

  it('不需要密钥的服务商（本地网关）不被拦截', () => {
    const stream = fakeStream()
    // 临时登记一个不需要密钥的模板，验证的是"模板说了算"这条规则本身。
    const templates = PROVIDER_TEMPLATES as Record<string, (typeof PROVIDER_TEMPLATES)[string]>
    const original = templates.local
    templates.local = { label: '本地', baseUrl: 'http://127.0.0.1:8080/v1', models: [], defaultModel: '', requiresKey: false }
    try {
      const controller = new ChatController({
        settings: { providerId: 'local', baseUrl: 'http://127.0.0.1:8080/v1', model: 'local-model' },
        secret: '', sessions: [], stream: stream.send,
      })
      expect(controller.hasKey()).toBe(true)
      expect(controller.send('你好')).toBe(true)
      expect(controller.snapshot().failure).toBeNull()
    } finally {
      if (original === undefined) delete templates.local
      else templates.local = original
    }
  })

  it('模板里没有的服务商按需要密钥处理，不放行', () => {
    const controller = new ChatController({
      settings: { providerId: 'unknown-provider', baseUrl: 'https://x.test/v1', model: 'm' },
      secret: '', sessions: [], stream: fakeStream().send,
    })
    expect(controller.hasKey()).toBe(false)
    expect(controller.send('你好')).toBe(false)
    expect(controller.snapshot().failure?.kind).toBe('no-key')
  })
})

describe('流式增量被逐字追加', () => {
  it('多个增量按到达顺序累加进同一个助手气泡', () => {
    const stream = fakeStream()
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: stream.send })
    expect(controller.send('你好')).toBe(true)

    // 发起时先放一个空的助手气泡，用户立刻能看到"正在回复"
    expect(controller.isStreaming()).toBe(true)
    expect(answerText(controller)).toBe('')

    const hooks = lastHandlers(stream)
    hooks.onDelta('你')
    expect(answerText(controller)).toBe('你')
    hooks.onDelta('好')
    expect(answerText(controller)).toBe('你好')
    hooks.onDelta('，世界')
    expect(answerText(controller)).toBe('你好，世界')

    // 用户消息留在助手气泡之前，顺序不能反
    expect(shape(controller)[0]).toEqual({ role: 'user', content: '你好' })
  })

  it('逐字节到达时，每个字节都各自触发一次可见更新', () => {
    const stream = fakeStream()
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: stream.send })
    const seen: string[] = []
    controller.subscribe(() => { seen.push(answerText(controller)) })
    controller.send('你好')

    const hooks = lastHandlers(stream)
    for (const byte of '流式') hooks.onDelta(byte)

    // 订阅回调观察到的是"每加一个字后的完整状态"，不是最后一次性拼接
    expect(seen).toEqual(['', '流', '流式'])
    expect(answerText(controller)).toBe('流式')
  })

  it('请求带上了系统提示、历史消息与用户当前这一句', () => {
    const stream = fakeStream()
    const history: StoredSession[] = [{
      id: 's1', title: '旧对话', updatedAt: 1,
      messages: [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '第一答' }],
    }]
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: history, stream: stream.send })
    controller.send('第二句')

    const sent = stream.calls[0]
    expect(sent?.model).toBe('deepseek-chat')
    expect(sent?.apiKey).toBe('sk-x')
    expect(sent?.messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二句' },
    ] satisfies ChatMessage[])
  })

  it('收流后落盘，刷新页面（新建控制器）仍能读回这段对话', () => {
    installStorage()
    const stream = fakeStream()
    const first = new ChatController({ stream: stream.send })
    first.newSession()
    first.saveConnection(READY, 'sk-x')
    first.send('落盘检查')
    lastHandlers(stream).onDelta('好的')
    lastHandlers(stream).onDone()

    const reloaded = new ChatController({ stream: stream.send })
    expect(shape(reloaded)).toEqual([
      { role: 'user', content: '落盘检查' },
      { role: 'assistant', content: '好的' },
    ])
    expect(reloaded.snapshot().sessions[0]?.title).toBe('落盘检查')
  })

  it('收流前就被拒的失败不留空气泡', () => {
    const stream = fakeStream()
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: stream.send })
    controller.send('你好')
    lastHandlers(stream).onError(new ChatFailure('server-error', FAILURE_COPY['server-error'], 503))

    expect(controller.snapshot().failure?.kind).toBe('server-error')
    expect(controller.snapshot().failure?.message).toBe(FAILURE_COPY['server-error'])
    // 只有用户那条，没有多余的空白助手气泡
    expect(shape(controller)).toEqual([{ role: 'user', content: '你好' }])
    expect(controller.isStreaming()).toBe(false)
  })

  it('已经流出一部分再失败时，保留已收到的内容并给出原因', () => {
    const stream = fakeStream()
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: stream.send })
    controller.send('你好')
    lastHandlers(stream).onDelta('部分回答')
    lastHandlers(stream).onError(new ChatFailure('network', FAILURE_COPY.network))

    expect(answerText(controller)).toBe('部分回答')
    expect(controller.snapshot().failure?.kind).toBe('network')
  })

  it('失败文案里没有技术堆栈痕迹', () => {
    for (const kind of Object.keys(FAILURE_COPY) as (keyof typeof FAILURE_COPY)[]) {
      const text = failureCopy(new ChatFailure(kind, FAILURE_COPY[kind]))
      expect(text, kind).not.toMatch(/Error|at \w+\.|stack|undefined|\[object/i)
    }
  })
})

describe('按「停止」是安静结束，不是报错', () => {
  it('abort 转发给流，且不抛异常', () => {
    const stream = fakeStream()
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: stream.send })
    controller.send('你好')
    expect(() => controller.abort()).not.toThrow()
    expect(stream.aborted()).toBe(1)
  })

  it('abort 之后到达的 aborted 回调不留错误、不留空气泡', () => {
    const stream = fakeStream()
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: stream.send })
    const failures: (ChatFailure | null)[] = []
    controller.subscribe(() => { failures.push(controller.snapshot().failure) })
    controller.send('你好')
    controller.abort()
    // 真实的 abort 是异步送达的
    lastHandlers(stream).onError(new ChatFailure('aborted', FAILURE_COPY.aborted))

    expect(controller.snapshot().failure).toBeNull()
    expect(controller.isStreaming()).toBe(false)
    expect(failures.every(item => item === null)).toBe(true)
    expect(shape(controller)).toEqual([{ role: 'user', content: '你好' }])
  })

  it('abort 保留已经流出来的部分回答', () => {
    const stream = fakeStream()
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: stream.send })
    controller.send('你好')
    lastHandlers(stream).onDelta('说到一半')
    controller.abort()
    lastHandlers(stream).onError(new ChatFailure('aborted', FAILURE_COPY.aborted))

    expect(answerText(controller)).toBe('说到一半')
    expect(controller.snapshot().failure).toBeNull()
  })

  it('没有进行中的流时 abort 是安全的空操作', () => {
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: fakeStream().send })
    expect(() => controller.abort()).not.toThrow()
  })

  it('收流之后再 abort 不会改变任何状态', () => {
    const stream = fakeStream()
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: stream.send })
    controller.send('你好')
    lastHandlers(stream).onDelta('答完')
    lastHandlers(stream).onDone()
    const before = shape(controller)
    controller.abort()
    expect(shape(controller)).toEqual(before)
    expect(controller.snapshot().failure).toBeNull()
  })
})

describe('设置保存后能读回', () => {
  it('saveConnection 之后 loadSettings 与 loadSecret 读回同一份', () => {
    installStorage()
    const controller = new ChatController({ stream: fakeStream().send })
    const custom = { providerId: 'custom', baseUrl: 'https://my.gateway/v1', model: 'my-model' }

    expect(controller.saveConnection(custom, 'sk-mine')).toBe(true)
    expect(loadSettings()).toEqual(custom)
    expect(loadSecret()).toBe('sk-mine')
    // 连接设置那份里绝不出现密钥
    expect(JSON.stringify(loadSettings())).not.toContain('sk-mine')
    expect(controller.snapshot().settings).toEqual(custom)
    expect(controller.modelLabel()).toBe('my-model')
  })

  it('换服务商后，新的模型清单立刻生效', () => {
    installStorage()
    const controller = new ChatController({ stream: fakeStream().send })
    expect(controller.modelLabel()).toBe(MODEL_BRAND)
    expect(controller.modelOptions().map(option => option.id)).toEqual(['deepseek-chat', 'deepseek-reasoner'])

    controller.saveConnection({ providerId: 'custom', baseUrl: 'https://my.gateway/v1', model: 'gateway-a' }, 'sk-x')
    expect(controller.modelOptions().map(option => option.id)).toEqual(['gateway-a'])
    expect(controller.snapshot().settings.model).toBe('gateway-a')
    // 换过去之后读回来的也是新的那一份
    expect(loadSettings().providerId).toBe('custom')
    expect(loadSettings().model).toBe('gateway-a')
  })

  it('存储写入失败时返回 false，而不是抛给界面', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError') },
      removeItem: () => {},
    })
    const controller = new ChatController({
      settings: READY, secret: 'sk-x', sessions: [], stream: fakeStream().send,
    })
    expect(controller.saveConnection(READY, 'sk-y')).toBe(false)
  })

  it('会话写盘失败不影响已经显示出来的回答', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError') },
      removeItem: () => {},
    })
    const stream = fakeStream()
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: stream.send })
    controller.send('你好')
    expect(() => { lastHandlers(stream).onDelta('照常显示'); lastHandlers(stream).onDone() }).not.toThrow()
    expect(answerText(controller)).toBe('照常显示')
  })
})

describe('会话切换与快照稳定性', () => {
  it('新建对话清空当前消息，但已存的历史还在', () => {
    installStorage()
    const stream = fakeStream()
    const controller = new ChatController({ stream: stream.send })
    controller.newSession()
    controller.saveConnection(READY, 'sk-x')
    controller.send('第一段对话')
    lastHandlers(stream).onDelta('答')
    lastHandlers(stream).onDone()

    const savedId = controller.snapshot().sessionId
    controller.newSession()
    expect(shape(controller)).toEqual([])
    expect(controller.snapshot().sessionId).not.toBe(savedId)
    expect(controller.snapshot().sessions).toHaveLength(1)

    controller.openSession(savedId)
    expect(shape(controller)).toEqual([
      { role: 'user', content: '第一段对话' },
      { role: 'assistant', content: '答' },
    ])
  })

  it('切到不存在的会话不做任何事', () => {
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: fakeStream().send })
    const before = controller.snapshot()
    controller.openSession('does-not-exist')
    expect(controller.snapshot()).toBe(before)
  })

  it('同一版本内快照是同一个对象，状态改变后才换', () => {
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: fakeStream().send })
    const first = controller.snapshot()
    expect(controller.snapshot()).toBe(first)
    controller.send('你好')
    expect(controller.snapshot()).not.toBe(first)
  })

  it('连续两次发送不会叠一个流；流未结束前的第二次被拒绝', () => {
    const stream = fakeStream()
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: stream.send })
    controller.send('第一句')
    expect(controller.send('第二句')).toBe(false)
    expect(stream.calls).toHaveLength(1)
  })

  it('每条消息在创建时打上时间戳，且追加增量不会改它', () => {
    const stream = fakeStream()
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: stream.send })
    controller.send('你好')
    const stamped = controller.snapshot().messages[0]?.at
    expect(typeof stamped).toBe('number')

    lastHandlers(stream).onDelta('答')
    // 追加增量时沿用同一条消息的时间戳：否则流式期间气泡上的分钟数会来回跳
    expect(controller.snapshot().messages[0]?.at).toBe(stamped)
    expect(controller.snapshot().messages[1]?.at).toBe(stamped)
  })

  it('空白输入不发起请求', () => {
    const stream = fakeStream()
    const controller = new ChatController({ settings: READY, secret: 'sk-x', sessions: [], stream: stream.send })
    expect(controller.send('   ')).toBe(false)
    expect(controller.send('\n\t')).toBe(false)
    expect(stream.calls).toHaveLength(0)
  })
})

describe('连续同角色消息的分组', () => {
  it('连续两条用户消息合成一个气泡，助手消息另起一个', () => {
    const runs = groupRuns([
      { role: 'user', content: '甲' },
      { role: 'user', content: '乙' },
      { role: 'assistant', content: '答' },
      { role: 'assistant', content: '续' },
    ])
    expect(runs).toEqual([
      { role: 'user', content: '甲\n\n乙' },
      { role: 'assistant', content: '答\n\n续' },
    ])
  })

  it('空列表给出空列表', () => {
    expect(groupRuns([])).toEqual([])
  })
})
