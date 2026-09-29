/**
 * Open-state liveness: `openState` must never stay `'loading'` without an
 * owner. The conversation skeleton hides the composer for every `'loading'`
 * frame on a blank session (`ConversationRoot`'s settling phase), so a
 * stranded `'loading'` is a permanently hidden input box — the user-visible
 * defect these cases pin: it must always land on `'open'`, `'error'`, or
 * `'cold'`, or hand the state to the generation that superseded it.
 */

import { describe, expect, vi } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createClientTest } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { Session } from '../src/client/sessions/session.ts'
import type { SessionFollowRequest, SessionPage } from '../src/types.ts'
import { historyValue, plainTurn } from './event-script.client.ts'
import { sessionBench } from './remote/bench.client.ts'
import { FOLLOW, followScript, history } from './remote/session.client.ts'
import { followSnapshot } from './remote/history.client.ts'

/** A Session talks through the Gateway client; its dependency cone is the Typert registry and the Connection. */
const API_ROSTER = webApp.closure(['@deepseek-ai/dsh-api-gateway'])
const it = createClientTest({ roster: API_ROSTER })
const SID = 'fk-liveness' as SessionId
const PARENT = 'fk-liveness-parent' as SessionId
const CHILD = { parentSessionId: PARENT, childSessionId: SID, mode: 'continuable' as const }
/** The first client boot pays the cold module transform of the api cone. */
const COLD_BOOT_TIMEOUT_MS = 60_000

/** Every non-terminal reachable state a settled window can publish. */
function expectTerminal(session: Session): void {
  expect(['cold', 'open', 'error']).toContain(session.getSnapshot().openState)
}

describe('open-state liveness', () => {
  it('hands the state to the replacement generation when the address changes mid-open', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const stalled = Promise.withResolvers<RemoteResult<SessionPage>>()
    mock.stream(FOLLOW, followScript(() => stalled.promise))
    const opening = session.open()
    expect(session.getSnapshot().openState).toBe('loading')
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(6), 1, '新', '代'))))
    session.configureSubagent(CHILD, undefined)
    await vi.waitFor(() => { expect(mock.log.requests(FOLLOW)).toHaveLength(2) })
    stalled.resolve(history(plainTurn(SessionSeq(0), 0, '旧', '代')))
    await opening
    await vi.waitFor(() => { expectTerminal(session) })
    expect(session.getSnapshot().openState).toBe('open')
  }, COLD_BOOT_TIMEOUT_MS)

  it('settles a terminal state when applying the opening page throws a non-Remote failure', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(0), 0, 'a', 'b'))))
    // Any client-side exception while the opening page is assembled (a shape
    // the build cannot digest) escapes the Remote failure branch: the window
    // must still settle instead of keeping the composer hidden forever.
    vi.spyOn(session.eventSource, 'replace').mockImplementation(() => {
      throw new TypeError('opening page assembly bug')
    })
    await expect(session.open()).rejects.toThrow('opening page assembly bug')
    expectTerminal(session)
    expect(session.getSnapshot().openState).toBe('error')
  }, COLD_BOOT_TIMEOUT_MS)

  it('settles a terminal state when a wire frame the build cannot digest breaks the opening', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    // A host baseline carrying a record shape this client build does not know
    // (host and client artifacts drift independently here): the Remote call
    // itself succeeds, the opening page assembly throws a plain TypeError.
    mock.stream(FOLLOW, async ([request], stream) => {
      stream.push(followSnapshot(
        historyValue(plainTurn(SessionSeq(0), 0, 'a', 'b')),
        request as SessionFollowRequest,
        undefined,
        {
          revision: 0,
          activeAttempt: {
            attemptId: 'attempt-1' as never,
            startedAfterSeq: 5 as never,
            turn: 1,
            step: 0,
            nextIndex: 1,
            stream: [{ type: 'from-a-newer-host' }] as never,
          },
        },
      ))
    })
    await expect(session.open()).rejects.toThrow(TypeError)
    expectTerminal(session)
    expect(session.getSnapshot().openState).toBe('error')
  }, COLD_BOOT_TIMEOUT_MS)

  it('reopens after itself when the failed open is retried', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(0), 0, 'a', 'b'))))
    const replace = vi.spyOn(session.eventSource, 'replace').mockImplementationOnce(() => {
      throw new TypeError('one-off assembly bug')
    })
    await session.open().catch(() => {})
    expect(session.getSnapshot().openState).toBe('error')
    // The next open (the stage retrying, or a later selection) is not blocked
    // by the failed pass: no promise is retained and the state is retryable.
    replace.mockRestore()
    await session.open()
    expect(session.getSnapshot().openState).toBe('open')
  }, COLD_BOOT_TIMEOUT_MS)

  it('leaves cold — never loading — when the window is disposed mid-open', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    const stalled = Promise.withResolvers<RemoteResult<SessionPage>>()
    mock.stream(FOLLOW, followScript(() => stalled.promise))
    const opening = session.open()
    expect(session.getSnapshot().openState).toBe('loading')
    await session.dispose()
    stalled.resolve(history(plainTurn(SessionSeq(0), 0, 'a', 'b')))
    await opening
    expectTerminal(session)
  }, COLD_BOOT_TIMEOUT_MS)
})
