/** Qianshou vision status Remote: three independent facts about the opt-in computer-use adapter. */
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from 'zod'
import { driverFact, permissionFact, routeFact } from './probe.ts'
import type { VisionSnapshot } from './types.ts'

export type * from './types.ts'

/** Deployment-selected deadline for one status read. */
export interface Config {
  /**
   * Budget shared by the permission probe and the route lookup of a single read,
   * from 1000 through 120000 milliseconds. A cold driver launch on a slow desktop
   * needs more than a warm one. @default 15000
   */
  readonly probeTimeoutMs?: number
}

interface ResolvedConfig extends Config {
  readonly probeTimeoutMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { qianshouVision: QianshouVision }
}

/**
 * Host service reporting driver assembly, OS grants, and route image acceptance separately.
 * The computer-use service and its provider are optional: their absence is a reported fact,
 * never an activation failure. No method mounts a driver, changes a model route, or grants anything.
 */
export class QianshouVision extends TypertRemoteService {
  static inject = ['settings', 'llm']
  static Config: Schema<Config> = Schema.object({
    probeTimeoutMs: Schema.number().step(1).min(1000).max(120000).default(15000),
  })

  private readonly lifetime = new AbortController()
  private readonly resolved: ResolvedConfig

  constructor(ctx: Context, config: Config) {
    super(ctx, 'qianshouVision')
    this.resolved = config as ResolvedConfig
  }

  protected [Service.init](): void {
    this.ctx.effect(() => () => { this.lifetime.abort() }, 'qianshou-vision: probe lifetime')
  }

  private async snapshot(prompt: boolean): Promise<VisionSnapshot> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.resolved.probeTimeoutMs)])
    const driver = driverFact(this.ctx)
    const [permissions, route] = await Promise.all([
      permissionFact(this.ctx.get('tools'), driver, prompt, signal),
      routeFact(this.ctx, signal),
    ])
    return { driver, permissions, route, platform: process.platform, checkedAt: Date.now() }
  }

  /**
   * Read all three facts without raising any OS dialog; the permission probe runs with `prompt: false`.
   * @returns The current vision status; `unknown` fields name the probe that could not answer.
   */
  @Remote
  async state(): Promise<VisionSnapshot> { return this.snapshot(false) }

  /**
   * Explicit user action: ask the registered provider to request missing OS grants (`prompt: true`).
   * Without a registered provider this only re-reads status and reports `no-provider`.
   * @returns The vision status after the request returned.
   */
  @Remote
  async requestPermissions(): Promise<VisionSnapshot> { return this.snapshot(true) }
}

export default QianshouVision
