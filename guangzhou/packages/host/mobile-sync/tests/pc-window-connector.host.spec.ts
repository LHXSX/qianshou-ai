/**
 * 手机连接器（`PcWindowHttpPort`）对**真实** PC 会话网关的往返测试。
 *
 * 放在宿主侧而不是客户端包：它 import 宿主网关源码，而客户端包的 tsconfig 只包含自己的
 * `src`（也不该依赖宿主）。客户端包自身的测试用夹具替身，覆盖边界与校验。
 */
/**
 * The phone-side connector against a real gateway over a real socket.
 *
 * These cases run the shipped `PcWindowHttpPort` and the shipped
 * `PcWindowController` against the real gateway service and its real durable file,
 * reached through `node:http` rather than a mocked `fetch`. That is what makes the
 * wire contract — status codes, refusal envelopes and receipt shape — an assertion
 * instead of an assumption, and what lets "not delivered" be observed on the phone
 * side rather than only inside the gateway.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { PcWindowController, PcWindowGatewayError, PcWindowHttpPort } from '@deepseek-ai/dsh-client-pc-window-bridge'
import { PcWindowGateway, PcWindowStore } from '../src/gateway/index.ts'
import type { SessionCommandPort, WindowBinding as GatewayBinding, WindowCommand } from '../src/gateway/types.ts'
import type { WindowBinding, WindowJournal, WindowJournalStore } from '@deepseek-ai/dsh-client-pc-window-bridge'


/** 绑定到稳定键；与包内实现同构（该函数不在包的公开导出里）。 */
function originKey(binding: WindowBinding): string {
  return `${binding.accountId}\0${binding.pcId}\0${binding.sessionId}\0${binding.sourceDeviceId}`
}

const BINDING: WindowBinding = {
  accountId: 'account-owner',
  pcId: 'pc-desk-01',
  sessionId: 'session-primary' as SessionId,
  sourceDeviceId: 'phone-01',
}

/** A Session authority that admits everything but can be told to fail. */
class SessionAuthority implements SessionCommandPort {
  readonly calls: WindowCommand[] = []
  failing = false
  private present = true
  available(): boolean { return this.present }
  /** Model an unmounted Session authority. */
  setPresent(value: boolean): void { this.present = value }
  alreadyAccepted(): Promise<boolean> { return Promise.resolve(false) }
  dispatch(binding: GatewayBinding, command: WindowCommand): Promise<void> { return this.record(binding, command) }
  append(binding: GatewayBinding, command: WindowCommand): Promise<void> { return this.record(binding, command) }
  cancel(binding: GatewayBinding, command: WindowCommand): Promise<void> { return this.record(binding, command) }
  private record(_binding: GatewayBinding, command: WindowCommand): Promise<void> {
    this.calls.push(command)
    if (this.failing) throw new PcWindowGatewayError('PC_WINDOW_SESSION_UNAVAILABLE')
    return Promise.resolve()
  }
}

/** One live gateway reachable over a real loopback socket. */
interface LiveGateway {
  readonly baseUrl: string
  readonly gateway: PcWindowGateway
  readonly authority: SessionAuthority
  readonly dispose: () => Promise<void>
}

/** Bind the real gateway routes to a real HTTP server on a loopback port. */
async function startGateway(): Promise<LiveGateway> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-window-client-'))
  const store = new PcWindowStore({ path: join(home, 'pc-window.json'), maxBindings: 10, maxCommands: 100, maxBytes: 1_048_576 })
  const authority = new SessionAuthority()
  const gateway = new PcWindowGateway(store, authority)
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const payload = JSON.parse(raw) as Record<string, unknown>
      const route = request.url ?? ''
      const answer = async (): Promise<{ status: number; body: unknown }> => {
        try {
          if (route.endsWith('/access')) return { status: 200, body: await gateway.access(payload.binding) }
          if (route.endsWith('/submit')) return { status: 200, body: await gateway.submit(payload.command) }
          return { status: 200, body: await gateway.sync(payload.binding, payload.cursor ?? null, payload.requestIds) }
        } catch (error) {
          const refusal = error as { code?: string; status?: number }
          return { status: refusal.status ?? 500, body: { error: { code: refusal.code ?? 'PC_WINDOW_FAILED' } } }
        }
      }
      void answer().then(({ status, body }) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      })
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test gateway did not bind a port')
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    gateway,
    authority,
    dispose: async () => {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      await store.close()
      await rm(home, { recursive: true, force: true })
    },
  }
}

/** Durable-enough local outbox: rows survive a controller rebuild. */
function createJournalStore(): WindowJournalStore {
  const rows = new Map<string, WindowJournal>()
  return {
    load: async origin => structuredClone(rows.get(originKey(origin)) ?? null),
    save: async (journal, expected) => {
      if ((rows.get(originKey(journal.binding))?.revision ?? 0) !== expected) throw new Error('PC_WINDOW_STALE_LOCAL_REVISION')
      rows.set(originKey(journal.binding), structuredClone(journal))
    },
    remove: async (origin) => { rows.delete(originKey(origin)) },
  }
}

const live: LiveGateway[] = []
afterEach(async () => { await Promise.all(live.splice(0).map(item => item.dispose())) })

/** Boot a real gateway and a real controller bound to it. */
async function connect(
): Promise<{ readonly live: LiveGateway; readonly controller: PcWindowController; readonly store: WindowJournalStore }> {
  const gateway = await startGateway()
  live.push(gateway)
  await gateway.gateway.registerBinding(BINDING)
  const store = createJournalStore()
  const controller = new PcWindowController({
    port: new PcWindowHttpPort({ baseUrl: gateway.baseUrl }),
    store,
    requestId: (() => { let next = 0; return () => `phone-request-${++next}` as SessionRequestId })(),
    now: () => Date.now(),
  })
  return { live: gateway, controller, store }
}

describe('phone connector to the real PC session gateway', () => {
  it('reads the gateway access verdict and completes a real dispatch round trip', async () => {
    const { live, controller } = await connect()
    await controller.connect(BINDING)
    expect(controller.snapshot()).toMatchObject({ binding: BINDING, access: 'online', error: null })

    const requestId = await controller.enqueue({ type: 'dispatch', text: 'continue on the PC' }, Date.now() + 60_000)
    await controller.flush()

    // The phone holds a real receipt for this exact request, and the PC authority
    // was actually asked to start the work.
    expect(controller.snapshot().records).toEqual([{
      command: {
        requestId, origin: BINDING, createdAt: expect.any(Number), expiresAt: expect.any(Number),
        action: { type: 'dispatch', text: 'continue on the PC' },
      },
      state: 'received',
      receipt: {
        requestId, origin: BINDING, revision: 1, state: 'received',
        childSessionId: 'session-primary', reason: 'session-admitted',
      },
    }])
    expect(live.authority.calls.map(command => command.requestId)).toEqual([requestId])

    // The receipt survives a rebuild of the phone's own journal too.
    await controller.refresh()
    expect(controller.snapshot()).toMatchObject({ cursor: 'qianshou.pc-window.cursor.v1:1', error: null })
  })

  it('shows a command as uncertain, not delivered, when the gateway cannot prove admission', async () => {
    const { live, controller } = await connect()
    await controller.connect(BINDING)
    live.authority.failing = true

    const requestId = await controller.enqueue({ type: 'dispatch', text: 'may or may not run' }, Date.now() + 60_000)
    // The admission attempt fails, and the phone is left with an unknown outcome
    // rather than a receipt it cannot justify.
    await expect(controller.flush()).rejects.toThrow()
    const record = controller.snapshot().records[0]
    expect(record).toMatchObject({ command: { requestId }, state: 'uncertain', receipt: null })

    // Reconciliation confirms the gateway has no receipt and no non-receipt proof,
    // so the phone still does not claim delivery.
    await controller.refresh()
    expect(controller.snapshot().records[0]).toMatchObject({ state: 'uncertain', receipt: null })
    expect(live.authority.calls.map(command => command.requestId)).toEqual([requestId])
  })

  it('surfaces the gateway refusal code and its resend verdict to the caller', async () => {
    const { live, controller } = await connect()
    await controller.connect(BINDING)
    const port = new PcWindowHttpPort({ baseUrl: live.baseUrl })
    const signal = new AbortController().signal
    const now = Date.now()
    const base = { origin: BINDING, createdAt: now, expiresAt: now + 60_000 }

    // A revision-bound control the gateway holds a newer revision for is refused
    // with its own code, and no resend is implied.
    const stale = await port.submit({
      ...base, requestId: 'phone-stale' as SessionRequestId,
      action: { type: 'append', targetSessionId: BINDING.sessionId, expectedRevision: 9, text: 'stale write' },
    }, signal).catch((error: unknown) => error)
    expect(stale).toBeInstanceOf(PcWindowGatewayError)
    expect((stale as PcWindowGatewayError).code).toBe('PC_WINDOW_REVISION_MISMATCH')
    expect((stale as PcWindowGatewayError).mayResend).toBe(false)

    // An origin the gateway has no binding for is refused as such.
    const foreign = await port.submit({
      ...base, requestId: 'phone-foreign' as SessionRequestId, origin: { ...BINDING, accountId: 'account-attacker' },
      action: { type: 'dispatch', text: 'not mine' },
    }, signal).catch((error: unknown) => error)
    expect((foreign as PcWindowGatewayError).code).toBe('PC_WINDOW_FOREIGN_ORIGIN')
    expect(live.authority.calls).toEqual([])
  })

  it('reports an unreachable gateway as a transport failure instead of a silent no-op', async () => {
    const { live } = await connect()
    const port = new PcWindowHttpPort({ baseUrl: live.baseUrl })
    await live.dispose()

    const now = Date.now()
    const failure = await port.submit({
      requestId: 'phone-offline' as SessionRequestId, origin: BINDING,
      createdAt: now, expiresAt: now + 60_000, action: { type: 'dispatch', text: 'unreachable' },
    }, new AbortController().signal).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PcWindowGatewayError)
    expect((failure as PcWindowGatewayError).code).toBe('PC_WINDOW_TRANSPORT_FAILED')
    // A transport failure is never permission to replay the command.
    expect((failure as PcWindowGatewayError).mayResend).toBe(false)
  })

  it('carries a real receipt page from the gateway to the phone journal', async () => {
    const { controller } = await connect()
    await controller.connect(BINDING)
    const requestId = await controller.enqueue({ type: 'dispatch', text: 'first task' }, Date.now() + 60_000)
    await controller.flush()

    // A second controller over the same durable local journal recovers the receipt
    // from the gateway's cursor page rather than from memory.
    const records = controller.snapshot().records
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ command: { requestId }, state: 'received' })
    await controller.refresh()
    expect(controller.snapshot()).toMatchObject({ error: null, cursor: 'qianshou.pc-window.cursor.v1:1' })
  })
})
