/** Real temporary SQLite and actual Session events; no network model or user files. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ConnectStore } from '../src/store.ts'
import { ConnectService } from '../src/service.ts'
import type { ConnectSessionPort } from '../src/session-port.ts'
import { projectConnectionPage } from '../src/projection.ts'
import { parseGrant, parseRequest } from '../src/validation.ts'

const sessionId = SessionId('fixture-selected'), otherId = SessionId('fixture-other')
const signal = (): AbortSignal => new AbortController().signal
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(maxGrants = 3, maxReceipts = 4) {
  const root = await mkdtemp(join(tmpdir(), 'session-connect-test-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'private', 'v1.sqlite'), store = await ConnectStore.open(path, maxGrants, maxReceipts)
  const ctx = new Context(); await ctx.plugin(SessionStore); cleanups.push(() => ctx.fiber.dispose())
  const session = ctx.sessions.create(sessionId), other = ctx.sessions.create(otherId)
  other.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'OtherPrivateText' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  let clock = 1000
  const submit = vi.fn<ConnectSessionPort['submit']>(async (id, rpcId, text, requestSignal, check) => {
    requestSignal.throwIfAborted(); check()
    ctx.sessions.get(id)!.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId } }), { surfaceOp: 'append' })
  })
  const port: ConnectSessionPort = {
    inspect: async (id, requestSignal) => { requestSignal.throwIfAborted(); const found = ctx.sessions.get(id); if (!found) throw new Error('missing'); return { events: found.snapshotEvents(), running: false } },
    admitted: async (id, rpcId) => ctx.sessions.get(id)!.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === rpcId), submit,
  }
  const service = new ConnectService(store, port, 4, 1000, () => clock)
  cleanups.push(() => service.dispose())
  const create = (mode: 'read' | 'text' = 'text') => service.create({ sessionId, label: 'Synthetic tablet', mode, durationMinutes: 1 })
  return { store, path, service, session, ctx, port, submit, create, advance: () => { clock += 60001 } }
}
describe('bounded owner authorization and durable command identity', () => {
  it('persists only token and body hashes, restores metadata, and never exposes another Session', async () => {
    const f = await fixture(), created = await f.create(), token = created.path.split('#')[1]!
    await f.service.send(token, 'request_001', 'SelectedUniqueMarker', signal())
    const page = await f.service.read(token, null, signal())
    expect(page.turns.map(turn => turn.text)).toEqual(['SelectedUniqueMarker'])
    expect(JSON.stringify(page)).not.toContain('OtherPrivateText')
    expect(JSON.stringify(f.service.state(sessionId, 'http://127.0.0.1:1234'))).not.toContain(token)
    await f.service.dispose()
    const bytes = await readFile(f.path)
    expect(bytes.includes(Buffer.from(token))).toBe(false); expect(bytes.includes(Buffer.from('SelectedUniqueMarker'))).toBe(false)
    expect((await stat(f.path)).mode & 0o777).toBe(0o600)
    const restored = await ConnectStore.open(f.path, 3, 4)
    try { expect(restored.authorize(token, 1001).acceptedCommands).toBe(1); expect(restored.receipt(created.grant.id, 'request_001')?.state).toBe('received') }
    finally { restored.close() }
  })
  it('defaults are explicit; rejects foreign fields, excessive lifetime, Unicode bytes and empty messages', () => {
    expect(() => parseGrant({ sessionId, label: 'x', mode: 'read', durationMinutes: 1441 })).toThrow('invalid-request')
    expect(() => parseRequest('send', { requestId: 'request_001', text: 'ok', sessionId: otherId })).toThrow('invalid-request')
    expect(() => parseRequest('send', { requestId: 'request_001', text: '界'.repeat(4096) })).toThrow('invalid-request')
    expect(() => parseRequest('send', { requestId: 'request_001', text: ' ' })).toThrow('invalid-request')
    expect(parseRequest('send', { requestId: 'request_001', text: '  test  ' })).toEqual({ requestId: 'request_001', text: 'test' })
  })
  it('rejects text for a readonly grant, revocation and expiry at the service executor', async () => {
    const f = await fixture(), readonly = await f.create('read'), token = readonly.path.split('#')[1]!
    expect(() => f.service.send(token, 'request_001', 'denied', signal())).toThrow('read-only')
    f.service.revoke(otherId, readonly.grant.id)
    await expect(f.service.read(token, null, signal())).resolves.toBeDefined()
    f.service.revoke(sessionId, readonly.grant.id)
    expect(() => f.service.read(token, null, signal())).toThrow('revoked')
    const second = await f.create(); f.advance()
    expect(() => f.service.read(second.path.split('#')[1]!, null, signal())).toThrow('expired')
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('coalesces concurrent identical commands and rejects a changed body even after receipt completion', async () => {
    const f = await fixture(), token = (await f.create()).path.split('#')[1]!
    const first = f.service.send(token, 'request_001', 'Once', signal()), second = f.service.send(token, 'request_001', 'Once', signal())
    expect(first).toBe(second)
    await expect(first).resolves.toMatchObject({ state: 'received' })
    await expect(f.service.send(token, 'request_001', 'Once', signal())).resolves.toMatchObject({ state: 'received' })
    await expect(f.service.send(token, 'request_001', 'Changed', signal())).rejects.toThrow('conflict')
    expect(f.submit).toHaveBeenCalledTimes(1)
  })
  it('retains uncertain claims after admission failure and never re-executes them on retry', async () => {
    const f = await fixture(), token = (await f.create()).path.split('#')[1]!
    f.submit.mockRejectedValueOnce(new Error('fixture interrupted before admission'))
    await expect(f.service.send(token, 'request_001', 'Uncertain', signal())).resolves.toMatchObject({ state: 'uncertain' })
    await expect(f.service.send(token, 'request_001', 'Uncertain', signal())).resolves.toMatchObject({ state: 'uncertain' })
    await expect(f.service.receipt(token, 'never_claimed', signal())).resolves.toMatchObject({ state: 'rejected' })
    expect(f.submit).toHaveBeenCalledTimes(1)
  })
  it('reconciles a claim whose original Session admission succeeded before receipt persistence', async () => {
    const f = await fixture(), created = await f.create(), token = created.path.split('#')[1]!
    const claimed = f.store.claim(created.grant.id, 'request_001', 'SavedBeforeCrash')
    f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'SavedBeforeCrash' }], source: { kind: 'user', rpcId: claimed.rpcId } }), { surfaceOp: 'append' })
    await expect(f.service.receipt(token, 'request_001', signal())).resolves.toMatchObject({ state: 'received' })
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('checks revocation again after a delayed session activation and waits for teardown', async () => {
    const f = await fixture(), created = await f.create(), token = created.path.split('#')[1]!
    const held: PromiseWithResolvers<void> = Promise.withResolvers()
    f.submit.mockImplementationOnce(async (_id, _rpc, _text, _signal, check) => { await held.promise; check() })
    const sending = f.service.send(token, 'request_001', 'MustNotAdmit', signal())
    await vi.waitFor(() => { expect(f.submit).toHaveBeenCalledTimes(1) })
    f.service.revoke(sessionId, created.grant.id)
    let disposed = false
    const disposal = f.service.dispose().then(() => { disposed = true })
    await Promise.resolve(); expect(disposed).toBe(false)
    held.resolve(); await sending; await disposal
    expect(f.session.snapshotEvents()).toHaveLength(0)
    expect(() =>{  f.service.authorize(token) }).toThrow('closed')
  })
  it('bounds retained grants and receipts without evicting active idempotency records', async () => {
    const f = await fixture(1, 1), created = await f.create(), token = created.path.split('#')[1]!
    await expect(f.create()).rejects.toThrow('capacity')
    await f.service.send(token, 'request_001', 'One', signal())
    await expect(f.service.send(token, 'request_002', 'Two', signal())).rejects.toThrow('capacity')
    await expect(f.service.send(token, 'request_001', 'One', signal())).resolves.toMatchObject({ state: 'received' })
    f.service.revoke(sessionId, created.grant.id)
    await expect(f.create()).resolves.toBeDefined()
  })
  it('resets a valid same-grant cursor when a restart retained an earlier durable tail', async () => {
    const f = await fixture(), grant = (await f.create()).grant
    const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    f.session.append('user/message', message('Durable prefix'), { surfaceOp: 'append' })
    const durable = f.session.snapshotEvents()
    f.session.append('user/message', message('Lost unflushed tail'), { surfaceOp: 'append' })
    const observed = projectConnectionPage(grant, f.session.snapshotEvents(), null, false)
    const restored = projectConnectionPage(grant, durable, observed.cursor, false)
    expect(restored.reset).toBe(true); expect(restored.hasMore).toBe(false)
    expect(restored.turns.map(turn => turn.text)).toEqual(['Durable prefix'])
    expect(projectConnectionPage(grant, durable, restored.cursor, false).reset).toBe(false)
    const empty = projectConnectionPage(grant, [], restored.cursor, false)
    expect(empty.reset).toBe(true); expect(empty.turns).toEqual([])
    expect(() => projectConnectionPage({ ...grant, id: 'another-grant' }, durable, observed.cursor, false)).toThrow('cursor-invalid')
  })
  it('bounds the complete escaped JSON page without skipping the next message', async () => {
    const f = await fixture(), grant = (await f.create()).grant
    for (let i = 0; i < 25; i++) f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '\u0000'.repeat(6000) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    let cursor: string | null = null, total = 0
    for (let pages = 0; pages < 10; pages++) {
      const result = projectConnectionPage(grant, f.session.snapshotEvents(), cursor, false)
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(240000)
      total += result.turns.length; cursor = result.cursor
      if (!result.hasMore) break
    }
    expect(total).toBe(25)
  })
  it('scopes cursors, pages committed text, hides replaced nodes and applies Unicode text bounds', async () => {
    const f = await fixture(), grant = (await f.create()).grant
    const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    for (let i = 0; i < 30; i++) f.session.append('user/message', message(`row-${i}`), { surfaceOp: 'append' })
    const first = projectConnectionPage(grant, f.session.snapshotEvents(), null, false)
    expect(first.turns).toHaveLength(25); expect(first.hasMore).toBe(true)
    const second = projectConnectionPage(grant, f.session.snapshotEvents(), first.cursor, false)
    expect(second.turns).toHaveLength(5); expect(second.hasMore).toBe(false)
    expect(() => projectConnectionPage({ ...grant, id: 'other-grant' }, f.session.snapshotEvents(), first.cursor, false)).toThrow('cursor-invalid')
    f.session.append('user/message', message('界'.repeat(5000)), { surfaceOp: { op: 'replace', startSeq: first.turns[0]!.seq, endSeq: first.turns[2]!.seq }, sourceEventSeqs: first.turns.slice(0, 3).map(turn => turn.seq) } as never)
    const changed = projectConnectionPage(grant, f.session.snapshotEvents(), second.cursor, false)
    expect(changed.reset).toBe(true)
    expect(changed.turns.some(turn => turn.text === 'row-0')).toBe(false)
    const final = projectConnectionPage(grant, f.session.snapshotEvents(), changed.cursor, false)
    expect(final.reset).toBe(false); expect(final.hasMore).toBe(false)
    expect(final.turns.at(-1)?.text).toHaveLength(2000); expect(final.turns.at(-1)?.truncated).toBe(true)
  })
})
