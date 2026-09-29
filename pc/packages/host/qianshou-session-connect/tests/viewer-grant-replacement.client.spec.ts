// @vitest-environment jsdom
/**
 * Regression: a second grant link opened in the same tab must load that grant.
 *
 * A link whose only difference is the URL fragment is an anchor navigation, so
 * the browser reuses the document and this module's initialization never runs
 * again. Before the `hashchange` reset, the page kept the previous grant's
 * denied state: the status stayed on the revoked copy, the tab credential
 * stayed cleared, and no `read` was issued for the new bearer. The assembled
 * browser path is covered by the running-app acceptance; this pins the handler.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const FIRST = '00000000-0000-4000-8000-000000000001.' + 'A'.repeat(43)
const SECOND = '00000000-0000-4000-8000-000000000002.' + 'B'.repeat(43)

/** One intercepted `read` response for the bearer that asked for it. */
function readBody(token: string): string {
  return JSON.stringify({
    sessionId: 'synthetic-session',
    label: token === FIRST ? 'FirstGrant' : 'SecondGrant',
    mode: 'text', expiresAt: Date.now() + 60_000, cursor: 'cursor', reset: true,
    hasMore: false, earlierOmitted: false, running: false,
    turns: [{ seq: 0, role: 'assistant', text: 'SyntheticRecord', truncated: false }],
  })
}

let bearers: string[]

beforeEach(() => {
  bearers = []
  document.body.innerHTML = '<main id="app"></main>'
  vi.stubGlobal('fetch', vi.fn(async (_input: string, init: { headers: Record<string, string> }) => {
    const token = (init.headers.Authorization ?? '').replace(/^Bearer /u, '')
    bearers.push(token)
    return new Response(readBody(token), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  sessionStorage.clear()
  document.body.replaceChildren()
})

it('loads a newly presented grant after a fragment-only navigation', async () => {
  window.location.hash = FIRST
  await import('../src/viewer/index.ts')
  await vi.waitFor(() => { expect(bearers).toContain(FIRST) })
  await vi.waitFor(() => { expect(document.querySelector('.badge')?.textContent).toContain('FirstGrant') })

  // Same document, new fragment: this is what a second link click produces.
  window.location.hash = SECOND
  window.dispatchEvent(new HashChangeEvent('hashchange'))

  await vi.waitFor(() => { expect(bearers).toContain(SECOND) })
  await vi.waitFor(() => { expect(document.querySelector('.badge')?.textContent).toContain('SecondGrant') })
  expect(JSON.parse(sessionStorage.getItem('qianshou-session-connect-tab-v1') ?? '{}')).toMatchObject({ token: SECOND })
})

it('ignores a fragment that is not a grant, leaving the current connection alone', async () => {
  window.location.hash = FIRST
  await import('../src/viewer/index.ts')
  await vi.waitFor(() => { expect(bearers).toContain(FIRST) })

  window.location.hash = 'not-a-grant'
  window.dispatchEvent(new HashChangeEvent('hashchange'))

  await Promise.resolve()
  expect(bearers).toEqual([FIRST])
  expect(JSON.parse(sessionStorage.getItem('qianshou-session-connect-tab-v1') ?? '{}')).toMatchObject({ token: FIRST })
})
