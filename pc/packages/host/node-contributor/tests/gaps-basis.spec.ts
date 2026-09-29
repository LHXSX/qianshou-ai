/**
 * C19 · 档 1 · 改动一：`productionGaps` 的**依据面**（gapsBasis）。
 *
 * 这一档**不改任何准入行为**：`productionGaps` 的返回值语义与 `productionGaps()` 本身一个字符没动
 * （它在本 profile 下仍然返回 `[]`，与 `resident-assembly.spec.ts:183-195` 钉住的契约一致）。
 * 它做的只有一件事：把「为什么这个数组是空的」变成**可读的事实**——铁律二意义上的「不再静默」。
 *
 * 为什么需要：C16 §A3 的证明是「默认 profile 下 `productionGaps` 恒空，不是因为缺口都补上了，
 * 而是因为 `plugin.ts` 的调用点传了两个字面量 `true`」。在那之前，这个事实只有读四处源码才能推断出来；
 * 下游（P0-12:308 的翻转规则、AT-08 的检查、真机证据语料里的 `[]`）全部按「缺口都补上了」读它。
 *
 * 本文件钉三件事：
 *   1. 依据面**如实**描述当前 profile（含「哪几项是被字面量抹掉的」）；
 *   2. `productionGaps` **仍然是 `[]`**（证明本档零行为变更）；
 *   3. **平台签名不是可达的准入权威**——`'platform-signed'` 这一支在类型与运行时都不可达。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import {
  apply,
  // 值与类型同名：把 schema 值改名，`Config` 在类型位置就明确是接口，不是 schema 实例。
  Config as ConfigSchema,
  DISPATCH_AUTHORITY_BASIS,
  NODE_CONTRIBUTOR_SERVICE,
  type DispatchAuthority,
  type NodeContributorGapsBasis,
  type Config,
  type NodeContributorService,
  type NodeContributorStatus,
} from '../src/plugin.ts'

interface RegisteredRoute { path: string; methods: readonly string[]; fetch: ConnectionFetchRoute['fetch'] }

const roots: string[] = []
const contexts: Context[] = []
const homeBefore = process.env.DSH_HOME

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (homeBefore === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = homeBefore
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function connectionStub(routes: RegisteredRoute[]): Plugin.Object {
  return {
    name: 'connection-stub',
    apply(ctx) {
      ctx.provide('connection', {
        fetch: {
          register: (route: ConnectionFetchRoute) => {
            routes.push({ path: route.path, methods: route.methods, fetch: route.fetch })
            return async () => { routes.length = 0 }
          },
        },
      })
    },
  }
}

/**
 * Mount the row on a real Cordis scope and hand back the operator projection.
 *
 * `autoStart: false` keeps the resident timer out of the picture: this file is about what the
 * projection *says*, not about driving the loop (`plugin.spec.ts:178-187` owns that). `DSH_HOME`
 * points at a scratch home so the **derived** attempt root of C16 §0.2 is exercised without ever
 * writing under the real `~/.deepseek-harness`。
 */
async function mount(config: Config, routes: RegisteredRoute[] = []): Promise<NodeContributorStatus> {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-gaps-basis-'))
  roots.push(root)
  process.env.DSH_HOME = join(root, 'home')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(connectionStub(routes))
  apply(ctx, ConfigSchema(config))
  const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService | undefined
  expect(service, 'the row must provide nodeContributor').toBeDefined()
  return service!.status()
}

describe('C19 · productionGaps 的依据面', () => {
  it('reads the shipped profile as [] while naming what the call site asserted away', async () => {
    const status = await mount({ autoStart: false })

    // (2) 零行为变更：与本档之前完全一样的读数。C16 判据 1 要求这一条与上一条同时成立。
    expect(status.productionGaps).toEqual([])

    // (1) 依据面如实：三个字面量抹掉的项被逐个点名，而不是消失。
    expect(status.gapsBasis).toEqual({
      workspaceRoot: 'derived',
      transport: 'edge-worker',
      dispatchAuthority: 'process-local-hmac',
      resultTransfer: 'inline-frame',
      satisfiedByAssertion: ['dispatchVerifier', 'dispatchLeaseSource', 'resultTransfer'],
    })
    // 依据面不是第二份手写声明：它从 productionGaps() 的「拿掉字面量会报什么」推出，
    // 所以「数组为空」与「有人替它断言」必须同时可读。
    expect(status.gapsBasis.satisfiedByAssertion.length).toBeGreaterThan(0)
  })

  it('derives the workspace basis from config instead of assuming it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-gaps-root-'))
    roots.push(root)
    const configured = await mount({ autoStart: false, workspaceRoot: join(root, 'attempts') })
    expect(configured.gapsBasis.workspaceRoot).toBe('configured')
    // 路径仍是真 seam 的判据：配置态与派生态都不在 gaps 里（`workspaceRoot` 从不出现在这里）。
    expect(configured.productionGaps).not.toContain('workspaceRoot')
  })

  it('names a genuine gap and asserts nothing when no type is advertised', async () => {
    const status = await mount({ autoStart: false, allowedTaskTypes: [] })

    // 这一档里 `memory` 是唯一能让三处「缺」如实出现在数组里的 profile：因为此时根本没有连线，
    // 也就没有调用点的字面量可断言 ⇒ satisfiedByAssertion 必须自然变空（依据面跟着数组走）。
    expect(status.gapsBasis).toEqual({
      workspaceRoot: 'derived',
      transport: 'memory',
      dispatchAuthority: 'none',
      resultTransfer: 'absent',
      satisfiedByAssertion: [],
    })
    expect(status.productionGaps).toEqual(['transport', 'dispatchVerifier', 'dispatchLeaseSource', 'resultTransfer'])
  })

  it('publishes the basis on the read-only status route so an operator can audit an empty array', async () => {
    const routes: RegisteredRoute[] = []
    await mount({ autoStart: false }, routes)
    expect(routes.map(route => route.path)).toEqual(['/api/qianshou/node/status'])
    const response = await routes[0]!.fetch(new Request('http://127.0.0.1/api/qianshou/node/status'))
    expect(response.status).toBe(200)
    const body = await response.json() as NodeContributorStatus
    expect(body.productionGaps).toEqual([])
    expect(body.gapsBasis.transport).toBe('edge-worker')
    expect(body.gapsBasis.dispatchAuthority).toBe('process-local-hmac')
    expect(body.gapsBasis.satisfiedByAssertion).toEqual(['dispatchVerifier', 'dispatchLeaseSource', 'resultTransfer'])
  })

  it('keeps a platform-signed dispatch authority unreachable, in the type and at run time', async () => {
    /**
     * 编译期那一半：`Record<DispatchAuthority, string>` 要求**每一个**成员都被描述。
     * 谁把 `'platform-signed'` 加进 `DispatchAuthority`，这一行就不再编译——即 C16 判据 2 所说的
     * 「先把 `'platform-signed'` 分支钉成不可达，否则它是一句空话」。
     * 运行时那一半：两个已交付 profile 都读不出这个值。
     */
    const described: Record<DispatchAuthority, string> = DISPATCH_AUTHORITY_BASIS
    expect(Object.keys(described).sort()).toEqual(['none', 'process-local-hmac'])
    expect(DISPATCH_AUTHORITY_BASIS).not.toHaveProperty('platform-signed')

    const observed = [
      (await mount({ autoStart: false })).gapsBasis.dispatchAuthority,
      (await mount({ autoStart: false, allowedTaskTypes: [] })).gapsBasis.dispatchAuthority,
    ]
    expect(observed).toEqual(['process-local-hmac', 'none'])
    // 今天的真实语义：镜像里**不存在**任何平台签名校验，所以也不存在任何一格可以写它。
    for (const authority of observed) expect(authority).not.toBe('platform-signed')
  })

  it('freezes the basis so a reader cannot mutate the evidence it just read', async () => {
    const status = await mount({ autoStart: false })
    const basis: NodeContributorGapsBasis = status.gapsBasis
    expect(Object.isFrozen(basis)).toBe(true)
    expect(Object.isFrozen(basis.satisfiedByAssertion)).toBe(true)
  })
})
