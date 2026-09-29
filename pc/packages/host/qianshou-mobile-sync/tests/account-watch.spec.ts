/**
 * Account observation without a change event: which phases count as signed in, and that each observed
 * change is delivered once, in order, with no delivery overlapping another or outliving `stop()`.
 */
import type { AccountSnapshot } from '@deepseek-ai/dsh-host-qianshou-account'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountWatch, signedInAccount } from '../src/account-watch.ts'

const watches: AccountWatch[] = []
afterEach(async () => {
  for (const watch of watches.splice(0)) await watch.stop()
})

/** One non-secret account snapshot; only `phase` and `account` decide registration. */
function snapshot(phase: AccountSnapshot['phase'], id: string | null): AccountSnapshot {
  return { phase, account: id === null ? null : { id, username: 'Owner' }, failure: null, verifiedAt: null, restorable: false, models: [], cloudSelected: false }
}

function watch(reads: readonly [AccountSnapshot | Error, ...(AccountSnapshot | Error)[]], intervalMs = 3_600_000) {
  const queue = [...reads]
  // The last scripted read repeats, so a watch that polls more often than the script says stays on its last answer.
  let last = queue[queue.length - 1]!
  const read = vi.fn(async (): Promise<AccountSnapshot> => {
    last = queue.shift() ?? last
    if (last instanceof Error) throw last
    return last
  })
  const delivered: (string | null)[] = []
  let block: Promise<void> | undefined
  const onChange = vi.fn(async (accountId: string | null) => {
    delivered.push(accountId)
    await block
  })
  const created = new AccountWatch(read, intervalMs, onChange)
  watches.push(created)
  return { created, read, onChange, delivered, hold: (promise: Promise<void>) => { block = promise } }
}

describe('which account counts as signed in', () => {
  it.each([
    ['authenticated', 'acct-1'],
    ['refreshing', 'acct-1'],
  ] as const)('accepts the account of a %s session', (phase, id) => {
    expect(signedInAccount(snapshot(phase, id))).toBe('acct-1')
  })

  it.each(['signed-out', 'authorizing', 'two-factor-required', 'unavailable', 'expired'] as const)('reports no account while %s', (phase) => {
    expect(signedInAccount(snapshot(phase, 'acct-1'))).toBeNull()
  })

  it('reports no account when the snapshot carries none, whatever the phase says', () => {
    expect(signedInAccount(snapshot('authenticated', null))).toBeNull()
  })
})

describe('delivering observed changes', () => {
  it('knows nothing before the first read and delivers the first account once', async () => {
    const { created, onChange, delivered } = watch([snapshot('authenticated', 'acct-1'), snapshot('authenticated', 'acct-1')])
    expect(created.account()).toBeUndefined()
    await created.tick()
    expect(created.account()).toBe('acct-1')
    expect(delivered).toEqual(['acct-1'])
    await created.tick()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('delivers a sign-out and a later sign-in in the order observed', async () => {
    const { created, delivered } = watch([
      snapshot('authenticated', 'acct-1'), snapshot('signed-out', null), snapshot('authenticated', 'acct-2'),
    ])
    await created.tick()
    await created.tick()
    await created.tick()
    expect(delivered).toEqual(['acct-1', null, 'acct-2'])
    expect(created.account()).toBe('acct-2')
  })

  it('keeps the last delivered account when a read fails', async () => {
    const { created, delivered } = watch([
      snapshot('authenticated', 'acct-1'), new Error('account service unavailable'), snapshot('authenticated', 'acct-1'),
    ])
    await created.tick()
    await created.tick()
    expect(created.account()).toBe('acct-1')
    expect(delivered).toEqual(['acct-1'])
  })

  it('never overlaps two deliveries, and the second waits for the first', async () => {
    const { created, delivered, hold } = watch([snapshot('authenticated', 'acct-1'), snapshot('signed-out', null)])
    let release = (): void => {}
    hold(new Promise<void>((resolve) => { release = resolve }))
    const first = created.tick()
    const second = created.tick()
    await vi.waitFor(() => { expect(delivered).toEqual(['acct-1']) })
    release()
    await first
    await second
    expect(delivered).toEqual(['acct-1', null])
  })

  it('keeps observing after a delivery fails, and does not redeliver the account it already reported', async () => {
    const { created, onChange, delivered } = watch([snapshot('authenticated', 'acct-1'), snapshot('authenticated', 'acct-1'), snapshot('signed-out', null)])
    onChange.mockImplementationOnce(async (accountId) => { delivered.push(accountId); throw new Error('registration failed') })
    await expect(created.tick()).resolves.toBeUndefined()
    expect(created.account()).toBe('acct-1')
    await created.tick()
    await created.tick()
    expect(delivered).toEqual(['acct-1', null])
  })

  it('reads immediately on start and keeps a repeated start to one interval', async () => {
    const { created, read } = watch([snapshot('authenticated', 'acct-1')], 3_600_000)
    created.start()
    created.start()
    await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(1) })
    await created.stop()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('polls again on its own interval', async () => {
    const { created, read } = watch([snapshot('authenticated', 'acct-1')], 1)
    created.start()
    await vi.waitFor(() => { expect(read.mock.calls.length).toBeGreaterThan(2) })
  })

  it('waits for a running delivery on stop, then neither reads nor delivers again', async () => {
    const { created, read, delivered, hold } = watch([snapshot('authenticated', 'acct-1'), snapshot('signed-out', null)])
    let release = (): void => {}
    hold(new Promise<void>((resolve) => { release = resolve }))
    const running = created.tick()
    await vi.waitFor(() => { expect(delivered).toEqual(['acct-1']) })
    const stopped = created.stop()
    release()
    await running
    await stopped
    const reads = read.mock.calls.length
    await created.tick()
    created.start()
    expect(delivered).toEqual(['acct-1'])
    expect(read.mock.calls).toHaveLength(reads)
  })

  it('drops a tick that stop reached before it began', async () => {
    const { created, onChange } = watch([snapshot('authenticated', 'acct-1')])
    const queued = created.tick()
    await created.stop()
    await queued
    expect(onChange).not.toHaveBeenCalled()
    expect(created.account()).toBeUndefined()
  })
})
