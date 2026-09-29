/**
 * Signed-in account observation. The account plugin publishes no change event, so the current account is read from
 * its non-secret snapshot at a configured interval; each observed change is delivered once, in order.
 */
import type { AccountSnapshot } from '@deepseek-ai/dsh-host-qianshou-account'

/**
 * Account this PC is signed in as, or `null` while no verified identity is usable for registration.
 * @param snapshot - Non-secret account status.
 * @returns Account id or `null`.
 */
export function signedInAccount(snapshot: AccountSnapshot): string | null {
  if (snapshot.account === null) return null
  return snapshot.phase === 'authenticated' || snapshot.phase === 'refreshing' ? snapshot.account.id : null
}

/** Periodic reader delivering account changes to one listener without overlapping deliveries. */
export class AccountWatch {
  private timer: NodeJS.Timeout | undefined
  private current: string | null | undefined
  private chain: Promise<void> = Promise.resolve()
  private stopped = false
  constructor(private readonly read: () => Promise<AccountSnapshot>, private readonly intervalMs: number,
    private readonly onChange: (accountId: string | null) => Promise<void>) {}
  /**
   * Last delivered account, or `undefined` before the first successful read.
   * @returns Account id, `null` when signed out, `undefined` before observation.
   */
  account(): string | null | undefined { return this.current }
  /** Begin observing; the first read happens immediately. */
  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    this.timer.unref()
    void this.tick()
  }
  /**
   * Read once and deliver a change if the account differs from the last delivered one.
   * @returns Settles after any delivery for this read.
   */
  tick(): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.stopped) return
      let next: string | null
      try { next = signedInAccount(await this.read()) } catch { return }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- stop() can arrive during the read above.
      if (this.stopped || next === this.current) return
      this.current = next
      await this.onChange(next)
    }).catch(() => undefined)
    return this.chain
  }
  /** Stop observing and wait for an in-flight delivery. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) { clearInterval(this.timer); this.timer = undefined }
    await this.chain
  }
}
