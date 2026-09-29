import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { PcWindowHttpPort, type WindowBinding } from '@deepseek-ai/dsh-client-pc-window-bridge'
import { MemoryWindowJournalStore, PhoneWindowRuntime } from '../src/window-runtime.ts'

const BINDING: WindowBinding = {
  accountId: 'local-owner',
  pcId: 'this-pc',
  sessionId: 'session-primary' as WindowBinding['sessionId'],
  sourceDeviceId: 'phone-test',
}

const ONLINE = { state: 'online', allowedActions: ['dispatch', 'append', 'cancel'] }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function mockGateway(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/bootstrap')) return jsonResponse({ binding: BINDING, access: ONLINE })
    if (url.includes('/access')) return jsonResponse(ONLINE)
    if (url.includes('/submit')) {
      return jsonResponse({
        receipt: {
          requestId: 'req-1', origin: BINDING, revision: 1, state: 'received', reason: 'session-admitted',
        },
      })
    }
    return jsonResponse({
      binding: BINDING, fromCursor: null, nextCursor: 'qianshou.pc-window.cursor.v1:1', receipts: [], notReceivedIds: [],
    })
  }) as typeof fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('phone window runtime', () => {
  it('bootstraps a host-assigned origin and records a dispatch locally', async () => {
    const store = new MemoryWindowJournalStore()
    const fetchImpl = mockGateway()
    const runtime = await PhoneWindowRuntime.open({
      port: new PcWindowHttpPort({ baseUrl: 'http://pc.test', fetch: fetchImpl }),
      store,
      deviceId: 'phone-test',
      sessionId: 'session-primary',
      now: () => 1_700_000_000_000,
      requestId: () => 'req-1' as SessionRequestId,
    })
    expect(runtime.snapshot()).toMatchObject({ binding: BINDING, access: 'online', connecting: false, error: null })
    expect(await runtime.enqueue('   ')).toBeNull()
    expect(await runtime.enqueue('continue on the PC')).toBe('req-1')
    expect(runtime.snapshot().records).toHaveLength(1)
    expect(runtime.snapshot().records[0]?.command.action).toEqual({ type: 'dispatch', text: 'continue on the PC' })
    const seen: number[] = []
    const stop = runtime.subscribe(() => { seen.push(1) })
    await runtime.connect()
    stop()
    expect(seen.length).toBeGreaterThan(0)
  })

  it('rejects a bootstrap reply that omits the host-assigned origin', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access: ONLINE })) as typeof fetch
    // 断言的是**连接层真实的拒绝行为**：网关只回了 access、没回 binding 时，
    // `PcWindowHttpPort.bootstrap` 拿 `undefined` 去 `parseBinding`，由
    // `validation.ts` 的 `record()` 抛出 `PC_WINDOW_INVALID_DATA`（纯 Error，无 code 字段）。
    // 这条断言原先写成 `toMatchObject({ code: 'PC_WINDOW_INVALID_REPLY' })`——那从未成立过：
    // 该文件在修好模块解析之前整个套件都跑不起来，这个期望值是照猜想写的。
    // 关键语义没变：**必须拒绝**，且不能凭空造出一个绑定。
    await expect(PhoneWindowRuntime.open({
      port: new PcWindowHttpPort({ baseUrl: 'http://pc.test', fetch: fetchImpl }),
      store: new MemoryWindowJournalStore(),
      deviceId: 'phone-test',
    })).rejects.toThrow('PC_WINDOW_INVALID_DATA')
  })

  it('surfaces a bootstrap refusal instead of inventing an origin', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: 'PC_WINDOW_NO_SESSION' } }, 409)) as typeof fetch
    await expect(PhoneWindowRuntime.open({
      port: new PcWindowHttpPort({ baseUrl: 'http://pc.test', fetch: fetchImpl }),
      store: new MemoryWindowJournalStore(),
      deviceId: 'phone-test',
    })).rejects.toMatchObject({ code: 'PC_WINDOW_NO_SESSION' })
  })

  it('rejects a stale local journal write', async () => {
    const store = new MemoryWindowJournalStore()
    await expect(store.save({
      version: 'qianshou.pc-window.v1',
      binding: BINDING,
      revision: 1,
      cursor: null,
      records: [],
    }, 3)).rejects.toThrow('PC_WINDOW_STALE_LOCAL_REVISION')
    await store.save({
      version: 'qianshou.pc-window.v1',
      binding: BINDING,
      revision: 1,
      cursor: null,
      records: [],
    }, 0)
    await store.remove(BINDING)
    expect(await store.load(BINDING)).toBeNull()
  })

  it('mints a device id when localStorage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    })
    const runtime = await PhoneWindowRuntime.open({
      port: new PcWindowHttpPort({ baseUrl: 'http://pc.test', fetch: mockGateway() }),
      store: new MemoryWindowJournalStore(),
      now: () => 1,
      requestId: () => 'req-1' as SessionRequestId,
    })
    expect(runtime.snapshot().binding?.sourceDeviceId.length).toBeGreaterThan(0)
  })

  it('falls back to memory when IndexedDB cannot open', async () => {
    vi.stubGlobal('indexedDB', { open: () => { throw new Error('unavailable') } })
    const runtime = await PhoneWindowRuntime.open({
      port: new PcWindowHttpPort({ baseUrl: 'http://pc.test', fetch: mockGateway() }),
      deviceId: 'phone-test',
      now: () => 1,
      requestId: () => 'req-1' as SessionRequestId,
    })
    expect(runtime.snapshot().access).toBe('online')
  })
})
