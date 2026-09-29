/** C29 read-only forensic probe. Not a test; deleted after evidence is captured. */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { AccountProtocol } from '../src/protocol.ts'
import { AccountSession } from '../src/session.ts'
import { accountStore, ACCOUNT_ACCESS_REF } from '../src/store.ts'

const config = { accountOrigin: 'https://account.example', gatewayBase: 'https://gateway.example/api', timeoutMs: 1000 }

/** Server that models rotation: each refresh invalidates the presented token. */
function rotatingServer(accessTtl = 3600) {
  let current = 'R1'
  let serial = 1
  const seen: string[] = []
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/auth/refresh')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { refresh_token?: string }
      const presented = body.refresh_token
      seen.push(presented ?? '<none>')
      if (presented !== current) {
        console.log(`  [server] REJECT stale token "${presented}" (current "${current}") -> 401`)
        return Response.json({ ok: false, code: 'AUTH_REFRESH_INVALID' }, { status: 401 })
      }
      serial += 1
      current = `R${serial}`
      console.log(`  [server] ROTATE ${presented} -> ${current} (200)`)
      return Response.json({ ok: true, tokens: { access_token: `A${serial}`, refresh_token: current, expires_in: accessTtl } })
    }
    if (url.endsWith('/auth/me')) return Response.json({ account: { id: '1', username: 'probe' } })
    return Response.json({ data: [{ id: 'm' }] })
  }
  return { fetcher: fetcher as typeof fetch, seen, current: () => current }
}

async function documentHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'c29-'))
}

async function main(): Promise<void> {
  console.log('=== P1 in-process concurrency: two concurrent access() calls ===')
  {
    const home = await documentHome()
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.credentials.modifyRecord(
      // seed one grant the way a completed login would
      (await import('@deepseek-ai/dsh-credentials')).credentialKey('qianshou-account', 'session'),
      async () => ({ kind: 'grant', payload: { version: 1, refresh: 'R1' } }),
    )
    const server = rotatingServer()
    const session = new AccountSession(new AccountProtocol(config, server.fetcher), accountStore(ctx.credentials))
    const [a, b] = await Promise.all([session.access(), session.access()])
    console.log(`  network refresh calls = ${server.seen.length} (presented ${JSON.stringify(server.seen)})`)
    console.log(`  both callers same token = ${a === b} (${a} / ${b})`)
    await session.dispose(); await ctx.fiber.dispose()
  }

  console.log('\n=== P2 two consumers (two windows/processes) sharing one credentials document ===')
  {
    const home = await documentHome()
    const path = join(home, '.credentials.yaml')
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { path, watch: false })
    const { credentialKey } = await import('@deepseek-ai/dsh-credentials')
    await ctx.credentials.modifyRecord(
      credentialKey('qianshou-account', 'session'),
      async () => ({ kind: 'grant', payload: { version: 1, refresh: 'R1' } }),
    )
    const server = rotatingServer()
    // Two independent owners over ONE durable document — the shape of a second
    // app instance, a second window, or the desktop app plus `dsh web`.
    const first = new AccountSession(new AccountProtocol(config, server.fetcher), accountStore(ctx.credentials))
    const second = new AccountSession(new AccountProtocol(config, server.fetcher), accountStore(ctx.credentials))
    await Promise.all([first.snapshot(), second.snapshot()]) // both read R1
    const one = await first.access().catch((error: unknown) => `ERR:${String(error)}`)
    const two = await second.access().catch((error: unknown) => `ERR:${String(error)}`)
    console.log(`  first  -> ${one}`)
    console.log(`  second -> ${two}`)
    console.log(`  tokens presented to server = ${JSON.stringify(server.seen)}`)
    console.log(`  server token now = ${server.current()}`)
    const doc = await readFile(path, 'utf8')
    console.log(`  persisted refresh present = ${doc.includes('refresh:')}; document tail = ${JSON.stringify(doc.split('\n').filter(l => l.includes('refresh')).join('|'))}`)
    await first.dispose(); await second.dispose(); await ctx.fiber.dispose()
  }

  console.log('\n=== P3 refresh response that cannot be parsed (CEO path: 200 received, not stored) ===')
  {
    const home = await documentHome()
    const path = join(home, '.credentials.yaml')
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { path, watch: false })
    const { credentialKey } = await import('@deepseek-ai/dsh-credentials')
    await ctx.credentials.modifyRecord(
      credentialKey('qianshou-account', 'session'),
      async () => ({ kind: 'grant', payload: { version: 1, refresh: 'R1' } }),
    )
    // The deployed envelope rotated the server-side token but the client cannot
    // decode it: camelCase keys inside `tokens`, exactly the shape the CEO hit.
    let calls = 0
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls += 1
      if (url.endsWith('/auth/refresh')) {
        console.log(`  [server] ROTATE R1 -> R2 (200) with undecodable body, call #${calls}`)
        return Response.json({ ok: true, tokens: { accessToken: 'A2', refreshToken: 'R2', expiresIn: 3600 } })
      }
      return Response.json({ account: { id: '1', username: 'probe' } })
    }) as typeof fetch
    const session = new AccountSession(new AccountProtocol(config, fetcher), accountStore(ctx.credentials))
    const status = await session.reconnect()
    console.log(`  status = ${JSON.stringify({ phase: status.phase, failure: status.failure, restorable: status.restorable })}`)
    const doc = await readFile(path, 'utf8')
    console.log(`  persisted refresh still old = ${doc.includes('R1')}`)
    console.log(`  refresh network calls so far = ${calls}`)
    const second = await session.reconnect()
    console.log(`  second reconnect = ${JSON.stringify({ phase: second.phase, failure: second.failure })}; calls = ${calls}`)
    console.log(`  document has no refresh left = ${!(await readFile(path, 'utf8')).includes('refresh')}`)
    await session.dispose(); await ctx.fiber.dispose()
  }

  console.log('\n=== P4 raw rejected body preserved? (evidence requirement) ===')
  {
    const fetcher = (async () => new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch
    const protocol = new AccountProtocol(config, fetcher)
    try {
      await protocol.request('/auth/refresh', 'POST', {}, null, new AbortController().signal)
    } catch (error) {
      console.log(`  thrown = ${String(error)} ; raw body available = ${JSON.stringify(error)}`)
    }
  }

  console.log('\n=== P5 does refresh hold the credentials document writer lock? ===')
  {
    const home = await documentHome()
    const path = join(home, '.credentials.yaml')
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { path, watch: false })
    const { credentialKey } = await import('@deepseek-ai/dsh-credentials')
    await ctx.credentials.modifyRecord(
      credentialKey('qianshou-account', 'session'),
      async () => ({ kind: 'grant', payload: { version: 1, refresh: 'R1' } }),
    )
    let lockObserved = false
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/auth/refresh')) {
        // While the refresh round trip is in flight, is the document locked?
        const { access } = await import('node:fs/promises')
        lockObserved = await access(`${path}.lock`).then(() => true, () => false)
        return Response.json({ ok: true, tokens: { access_token: 'A2', refresh_token: 'R2', expires_in: 3600 } })
      }
      return Response.json({ account: { id: '1', username: 'probe' } })
    }) as typeof fetch
    const session = new AccountSession(new AccountProtocol(config, fetcher), accountStore(ctx.credentials))
    await session.reconnect()
    console.log(`  <document>.lock held during refresh round trip = ${lockObserved}`)
    console.log(`  ACCOUNT_ACCESS_REF = ${ACCOUNT_ACCESS_REF}`)
    await session.dispose(); await ctx.fiber.dispose()
  }
}

await main()
