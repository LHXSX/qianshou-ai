/**
 * The Host sync route over the real network stack.
 *
 * Every request in this file travels through a real `node:http` socket to the real
 * webserver plugin, through the real Connection carrier and its Host fence and browser
 * authentication, into this package's route and its real file-backed store. Nothing
 * here is a `vi.fn()` transport and no response is fabricated by the test.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { MOBILE_SYNC_VERSION } from '@deepseek-ai/dsh-host-platform-observability-contract'
import { startHarness, type Harness } from './harness.ts'

const identity = { kind: 'agent', id: 'agent-mobile' } as const
const AT = '2026-09-15T02:03:04.000Z'

const harnesses: Harness[] = []
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.dispose()))
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function boot(): Promise<Harness> {
  const harness = await startHarness()
  harnesses.push(harness)
  return harness
}

function heartbeat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: MOBILE_SYNC_VERSION, identity, platform: 'web', agentVersion: '1.0.0', sequence: 1,
    sentAt: AT, surface: 'foreground', acceptance: 'autonomous', capabilities: [],
    maxConcurrency: 2, runningTasks: 0, cursor: 'start', ...overrides,
  }
}

function syncBody(cursor: string, limit = 20, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { request: { version: MOBILE_SYNC_VERSION, identity, cursor, limit }, heartbeat: heartbeat(overrides) }
}

/** The store file the plugin actually wrote for this harness. */
async function storedRecord(harness: Harness): Promise<{ revision: number; lastCursor: string; issuedAt?: number }> {
  const file = JSON.parse(await readFile(join(harness.home, 'mobile-sync.json'), 'utf8')) as {
    records: Record<string, { revision: number; lastCursor: string; issuedAt?: number }>
  }
  const record = file.records['agent\u0000agent-mobile']
  if (record === undefined) throw new Error('no durable record was written')
  return record
}

describe('mobile sync over a real HTTP socket', () => {
  it('completes a real round trip and advances the durable revision', async () => {
    const harness = await boot()
    const first = await harness.post('/api/qianshou/mobile/sync', syncBody('start'))
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      version: MOBILE_SYNC_VERSION, revision: 1, cursor: 'agent-agent-mobile-r1', outcome: 'advanced',
    })
    expect(await storedRecord(harness)).toMatchObject({ revision: 1, lastCursor: 'start' })

    // The next issued cursor advances the revision; the server never repeats one.
    const second = await harness.post('/api/qianshou/mobile/sync', syncBody('agent-agent-mobile-r1'))
    expect(second.body).toMatchObject({ revision: 2, cursor: 'agent-agent-mobile-r2', outcome: 'advanced' })
    expect(await storedRecord(harness)).toMatchObject({ revision: 2, lastCursor: 'agent-agent-mobile-r1' })
  })

  it('refuses an unauthenticated request before the handler runs', async () => {
    const harness = await boot()
    const anonymous = await harness.post('/api/qianshou/mobile/sync', syncBody('start'), { cookie: undefined })
    expect([anonymous.status, anonymous.body]).toEqual([401, 'unauthorized'])

    // The same request with the exchanged browser cookie reaches the handler.
    const authenticated = await harness.post('/api/qianshou/mobile/sync', syncBody('start'))
    expect(authenticated.status).toBe(200)
    expect(authenticated.body).toMatchObject({ revision: 1, outcome: 'advanced' })
  })

  it('refuses a foreign Host authority without adopting it', async () => {
    const harness = await boot()
    const rebound = await harness.post('/api/qianshou/mobile/sync', syncBody('start'), { host: 'attacker.example' })
    expect([rebound.status, rebound.body]).toEqual([403, 'forbidden'])
    // Nothing was written for the refused request.
    await expect(readFile(join(harness.home, 'mobile-sync.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('replays a retried cursor instead of consuming a second revision', async () => {
    const harness = await boot()
    await harness.post('/api/qianshou/mobile/sync', syncBody('start'))
    const replay = await harness.post('/api/qianshou/mobile/sync', syncBody('start'))
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ revision: 1, outcome: 'replayed' })

    // A later accepted cursor still advances the revision.
    const advanced = await harness.post('/api/qianshou/mobile/sync', syncBody('agent-agent-mobile-r1'))
    expect(advanced.body).toMatchObject({ revision: 2, outcome: 'advanced' })
  })

  it('holds an out-of-order cursor at the newer revision instead of advancing', async () => {
    const harness = await boot()
    await harness.post('/api/qianshou/mobile/sync', syncBody('start'))
    await harness.post('/api/qianshou/mobile/sync', syncBody('agent-agent-mobile-r1'))

    const stale = await harness.post('/api/qianshou/mobile/sync', syncBody('agent-agent-mobile-r0'))
    expect(stale.status).toBe(200)
    expect(stale.body).toMatchObject({ revision: 2, outcome: 'stale-cursor' })

    // The refused cursor left the durable revision untouched.
    const record = await storedRecord(harness)
    expect(record).toMatchObject({ revision: 2, lastCursor: 'agent-agent-mobile-r1' })

    const stillTwo = await harness.post('/api/qianshou/mobile/sync', syncBody('agent-agent-mobile-r1'))
    expect(stillTwo.body).toMatchObject({ revision: 2, outcome: 'replayed' })
  })

  it('refuses a cursor text the server never issued instead of treating it as progress', async () => {
    const harness = await boot()
    await harness.post('/api/qianshou/mobile/sync', syncBody('start'))

    // A malformed cursor previously slipped past the out-of-order check and advanced
    // the revision; it must now be refused without mutating durable state.
    const malformed = await harness.post('/api/qianshou/mobile/sync', syncBody('agent-agent-mobile-r1-start'))
    expect(malformed.status).toBe(400)
    expect(malformed.body).toMatchObject({ error: { code: 'MOBILE_SYNC_CURSOR_INVALID' } })

    const opaque = await harness.post('/api/qianshou/mobile/sync', syncBody('some-other-cursor'))
    expect(opaque.status).toBe(400)
    expect(opaque.body).toMatchObject({ error: { code: 'MOBILE_SYNC_CURSOR_INVALID' } })

    // A cursor naming a revision the server never issued is refused, never adopted.
    const future = await harness.post('/api/qianshou/mobile/sync', syncBody('agent-agent-mobile-r99'))
    expect([future.status, future.body]).toEqual([409, { error: { code: 'MOBILE_SYNC_CURSOR_FUTURE', message: 'MOBILE_SYNC_CURSOR_FUTURE' } }])

    expect(await storedRecord(harness)).toMatchObject({ revision: 1, lastCursor: 'start' })
    const accepted = await harness.post('/api/qianshou/mobile/sync', syncBody('agent-agent-mobile-r1'))
    expect(accepted.body).toMatchObject({ revision: 2, outcome: 'advanced' })
  })

  it('refuses an expired cursor and requires an explicit restart to recover', async () => {
    const harness = await startHarness({ cursorMaxAgeMs: 60_000, clock: () => ATTEMPT_EPOCH })
    harnesses.push(harness)

    // A normal sync issues a real cursor with an issuance time.
    const issued = await harness.post('/api/qianshou/mobile/sync', syncBody('start'))
    expect(issued.body).toMatchObject({ revision: 1, cursor: 'agent-agent-mobile-r1', outcome: 'advanced' })
    const record = await storedRecord(harness)
    expect(record).toMatchObject({ revision: 1, lastCursor: 'start' })
    expect(typeof record.issuedAt).toBe('number')

    // The phone goes away and comes back after the cursor's lifetime; resuming the
    // issued cursor is refused rather than silently continuing from a position the
    // server may no longer describe.
    harness.setClock(() => ATTEMPT_EPOCH + 60_001)
    const expired = await harness.post('/api/qianshou/mobile/sync', syncBody('agent-agent-mobile-r1'))
    expect(expired.status).toBe(409)
    expect(expired.body).toMatchObject({ error: { code: 'MOBILE_SYNC_CURSOR_INVALID' } })
    expect(await storedRecord(harness)).toMatchObject({ revision: 1 })

    // The recovery path stays open: an explicit restart is issued a fresh cursor and a
    // fresh lifetime instead of leaving the phone permanently locked out.
    const restarted = await harness.post('/api/qianshou/mobile/sync', syncBody('start'))
    expect(restarted.status).toBe(200)
    expect(restarted.body).toMatchObject({ revision: 2, cursor: 'agent-agent-mobile-r2', outcome: 'advanced' })
    const refreshed = await storedRecord(harness)
    expect(refreshed).toMatchObject({ revision: 2, lastCursor: 'start' })
    expect(refreshed.issuedAt).toBe(ATTEMPT_EPOCH + 60_001)

    // And the freshly issued cursor advances again on the next ordinary sync, even though
    // the wall clock is already past the previous cursor's lifetime.
    harness.setClock(() => ATTEMPT_EPOCH + 90_000)
    const advanced = await harness.post('/api/qianshou/mobile/sync', syncBody('agent-agent-mobile-r2'))
    expect(advanced.status).toBe(200)
    expect(advanced.body).toMatchObject({ revision: 3, outcome: 'advanced' })
  })

  it('refuses malformed and oversized bodies without writing state', async () => {
    const harness = await boot()
    const notJson = await harness.post('/api/qianshou/mobile/sync', 'not-json')
    expect(notJson.status).toBe(400)
    expect(notJson.body).toMatchObject({ error: { code: 'MOBILE_SYNC_REQUEST_INVALID' } })

    const wrongVersion = await harness.post('/api/qianshou/mobile/sync', { request: { version: 'qianshou.mobile.sync.v0', identity, cursor: 'start', limit: 20 }, heartbeat: heartbeat() })
    expect(wrongVersion.status).toBe(400)
    expect(wrongVersion.body).toMatchObject({ error: { code: 'MOBILE_SYNC_REQUEST_INVALID' } })

    const tooLarge = await harness.post('/api/qianshou/mobile/sync', { request: { version: MOBILE_SYNC_VERSION, identity, cursor: 'start', limit: 20 }, heartbeat: heartbeat(), padding: 'x'.repeat(70_000) })
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.body).toMatchObject({ error: { code: 'MOBILE_SYNC_REQUEST_TOO_LARGE' } })

    const foreignHeartbeat = await harness.post('/api/qianshou/mobile/sync', {
      request: { version: MOBILE_SYNC_VERSION, identity, cursor: 'start', limit: 20 },
      heartbeat: heartbeat({ identity: { kind: 'agent', id: 'agent-other' } }),
    })
    expect(foreignHeartbeat.status).toBe(400)
    expect(foreignHeartbeat.body).toMatchObject({ error: { code: 'MOBILE_SYNC_HEARTBEAT_INVALID' } })

    const invalidHeartbeat = await harness.post('/api/qianshou/mobile/sync', {
      request: { version: MOBILE_SYNC_VERSION, identity, cursor: 'start', limit: 20 },
      heartbeat: heartbeat({ runningTasks: 99 }),
    })
    expect(invalidHeartbeat.status).toBe(400)
    expect(invalidHeartbeat.body).toMatchObject({ error: { code: 'MOBILE_SYNC_HEARTBEAT_INVALID' } })

    await expect(readFile(join(harness.home, 'mobile-sync.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

/** Fixed epoch the expiry case ages away from; no wall clock participates. */
const ATTEMPT_EPOCH = 1_789_427_400_000

describe('durable store failures', () => {
  it('reports an unusable store instead of silently accepting progress', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-mobile-sync-broken-'))
    temporary.push(home)
    // A directory where the store file belongs makes every write fail.
    const harness = await startHarness({ statePath: home })
    harnesses.push(harness)
    const refused = await harness.post('/api/qianshou/mobile/sync', syncBody('start'))
    expect(refused.status).toBe(503)
    expect(refused.body).toMatchObject({ error: { code: 'MOBILE_SYNC_STORE_UNAVAILABLE' } })
  })
})
