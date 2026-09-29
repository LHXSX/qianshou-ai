/**
 * C19 · 档 1 · 改动二：**两条并排钉子**——他签（平台签名）必拒 / 自签必过。
 *
 * ## 为什么必须并排
 *
 * 这两条单独看都会被误读：
 * - 只看「自签必过」⇒ 会以为 `verifySignature` 是一道**平台授权**闸门，只是"我们还没有平台密钥"；
 * - 只看「他签必拒」⇒ 会以为护栏在"密钥不对"上，于是"把平台密钥配进来"看起来像一次**收紧**。
 *
 * 并排读出来的才是 C16 §0.2 / §A1 钉住的那个事实：
 * **准入权威 ≡ 套接字归属**（`report-C16-N1准入证据与收紧方案.md:516-523`）。签名验的是
 * **本进程自己**刚才签的东西 —— 它是**自洽性检查**，不是授权检查；平台签名的帧不是"被额外拦住"，
 * 而是**从来不构成任何准入权威**：链路里没有任何一处读过平台签名。
 *
 * ## 今天真实生效的机制（不是本工包发明的）
 *
 * `createInlineEdgeBinding`（`compute-core/src/transport/inline-edge-bridge.ts:81`）在没有注入
 * `sessionKey` 时用 `randomBytes(32)` **在本进程内**生成密钥，`:128` 用它给译出的 offer 签名，
 * `:84-89` 又用**同一把**密钥验签。密钥从不落盘、从不出进程 ⇒ 任何外部主体（包括平台派发侧）
 * 都无法构造一个能通过的签名。这正是 `node-contributor` 交付 profile 的真实密钥来源
 * （`edge-binding.ts:105` 不传 `sessionKey`）。
 *
 * ## 这一对钉子钉住什么
 *
 * 谁改动任何一侧都会红：
 * - 若有人**删掉**验签（让 `verifySignature` 恒真）⇒ 「他签必拒」红；
 * - 若有人把密钥来源换成一份**平台下发**的密钥材料 ⇒ 「他签必拒」（同一把外键仍然过不了本进程验签）
 *   与「自签必过」（自签不再被本进程承认）至少一条红，且 `edge-binding` 的形状会变;
 * - 若有人把这条链**说成**平台签名校验（§4 的口径问题）⇒ 本文件的两条断言会把这句话证伪。
 */
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assignmentFingerprint,
  ComputeTaskStore,
  createInlineEdgeBinding,
  EmployeeTaskCoordinator,
  ISOLATED_INLINE_SESSION_DIGEST,
  verifyTaskAssignment,
  type EdgeTaskOffer,
  type InlineEdgeBinding,
} from '@deepseek-ai/dsh-compute-core'
import type { NodeTaskOfferMessage } from '@deepseek-ai/dsh-compute-core/node-protocol'
import type { ResidentControlPort, ResidentOfferRequest } from '@deepseek-ai/dsh-compute-core/resident'
import { createResidentControlPort } from '../src/resident-port.ts'

const NOW = '2026-09-22T04:00:00.000Z'
const NODE_ID = 'node-nail-1'
const TASK_TYPES = ['word_count'] as const

/**
 * 一个**想象中**能派单给本机的平台派发侧所持有的签名密钥。
 *
 * 它是"他签"这一侧的全部输入：固定的 32 字节、形态与长度都与真密钥无法区分。用它签出来的
 * 签名**覆盖的是正确的指纹**，所以它是最强的伪造形态——如果链路里存在任何一处平台签名校验，
 * 这一条就应该过。
 */
const PLATFORM_SIGNING_KEY = Buffer.alloc(32, 0x5a)

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** One `shard_assign`-shaped frame: every field legal, `code_url` present and never fetched. */
function offer(overrides: Partial<EdgeTaskOffer> = {}): EdgeTaskOffer {
  return Object.freeze({
    workerId: 'worker-1',
    workloadId: 'workload-nail',
    shardId: 'shard-1',
    attempt: 0,
    taskType: 'word_count',
    runtime: 'node',
    inputKind: 'inline',
    inlineInput: 'count these words',
    inputRef: '',
    inputRefs: [],
    codeUrl: 'https://untrusted.example/script.py',
    codeSha256: '',
    timeoutSeconds: 60,
    verificationPolicy: 'semantic',
    executionModel: '',
    capability: '',
    capabilityVersion: '',
    ...overrides,
  })
}

interface Nail {
  binding: InlineEdgeBinding
  /** The offer the node's own bridge translated and signed. */
  mapped: NodeTaskOfferMessage
  /** The exact assignment facts the signature covers, read from the translated offer. */
  assignment: {
    envelope: NodeTaskOfferMessage['envelope']
    attempt: number
    capabilityPluginDigest: string
    leaseExpiresAt: string
    receivedAt: string
  }
  fingerprint: string
  port: ResidentControlPort
}

/**
 * Translate one frame through the **real** bridge (the shipped verifier), then bind the **real**
 * control-plane port on top of it — so both nails are read at the admission boundary an offer
 * actually crosses, not at a test double of it.
 */
async function nail(options: { sessionKey?: Buffer } = {}): Promise<Nail> {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-authority-nail-'))
  roots.push(root)
  const binding = createInlineEdgeBinding({
    nodeId: NODE_ID,
    allowedTaskTypes: [...TASK_TYPES],
    maxOutputBytes: 4_096,
    ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
  })
  const mapped = binding.bridge.toNodeOffer(offer(), { receivedAt: NOW, workerId: 'worker-1' })
  if ('refuse' in mapped) throw new Error(`the nail fixture must not refuse: ${mapped.refuse}`)
  const assignment = {
    envelope: mapped.envelope,
    attempt: mapped.attempt,
    capabilityPluginDigest: ISOLATED_INLINE_SESSION_DIGEST,
    leaseExpiresAt: mapped.leaseExpiresAt,
    receivedAt: mapped.receivedAt,
  }
  const store = new ComputeTaskStore({ path: join(root, 'tasks.json'), maxTasks: 8, maxBytes: 65_536 })
  const coordinator = new EmployeeTaskCoordinator(store)
  const { port } = createResidentControlPort({
    nodeId: NODE_ID,
    agentVersion: 'agent-c19',
    policy: {
      mode: 'BACKGROUND_ONLY',
      maxConcurrency: 1,
      maxCpuPercent: 50,
      maxGpuPercent: 0,
      maxTemperatureC: 80,
      minDiskFreeBytes: 1_000,
      allowWhileUserActive: false,
    },
    coordinator,
    store,
    capabilities: () => [],
    transport: { publishHeartbeat: async () => undefined },
    // 交付 profile 的同一对函数：`plugin.ts:413-414` 也是这么接的。
    verifySignature: binding.verifySignature,
    leaseOf: (taskId, attempt, expiresAt) => binding.leaseOf(taskId, attempt, expiresAt),
  })
  return { binding, mapped, assignment, fingerprint: assignmentFingerprint(assignment), port }
}

/** One signed offer frame, exactly as the resident runtime hands it to the port. */
function request(mapped: NodeTaskOfferMessage, signature: string): ResidentOfferRequest {
  return {
    offer: { ...mapped, signature },
    signature,
    traceId: 'trace-authority-nail',
  }
}

/** Mint a signature under a key that is *not* this process's, over the correct fingerprint. */
function signatureUnder(key: Buffer, fingerprint: string): string {
  return createHmac('sha256', key).update(fingerprint).digest('hex')
}

describe('C19 · 准入权威的两条并排钉子：他签必拒 / 自签必过', () => {
  it('他签（平台签名）必拒：平台签名的 offer 不构成任何准入权威', async () => {
    const { binding, mapped, assignment, fingerprint, port } = await nail()
    const platformSignature = signatureUnder(PLATFORM_SIGNING_KEY, fingerprint)

    // 最强的伪造形态：字母表、长度都对，覆盖的就是**正确的**指纹。
    expect(platformSignature).toMatch(/^[a-f0-9]{64}$/u)
    // 但它不是本进程刚才签的那一份 —— 这一句就是"他签"与"自签"的分界。
    expect(platformSignature).not.toBe(mapped.signature)

    // ① 直接验签面：本进程的验证器不承认任何外来的、即使形态完美且指纹正确的签名。
    expect(binding.verifySignature(fingerprint, platformSignature)).toBe(false)
    await expect(verifyTaskAssignment(assignment, platformSignature, binding.verifySignature))
      .rejects.toMatchObject({ code: 'COMPUTE_TASK_SIGNATURE_INVALID' })

    // ② 帧里"带着"平台签名也没用：桥不读这个字段，它只用**自己的**密钥重签一份。
    const smuggled = binding.bridge.toNodeOffer(
      { ...offer(), signature: platformSignature } as EdgeTaskOffer,
      { receivedAt: NOW, workerId: 'worker-1' },
    )
    expect('refuse' in smuggled).toBe(false)
    if ('refuse' in smuggled) return
    expect(smuggled.signature).not.toBe(platformSignature)
    expect(smuggled.signature).toBe(mapped.signature)

    // ③ 准入边界：真端口（`resident-port.ts:92`）的读数。这不是"多拦了一道"，
    //    而是链路里**根本没有一处**读过平台签名 —— 拒单码来自"本进程不承认这个签名"。
    await expect(port.verifyOffer(request(mapped, platformSignature)))
      .resolves.toMatchObject({ accepted: false, code: 'COMPUTE_TASK_SIGNATURE_INVALID' })

    // ④ 同一结论不依赖"密钥是随机的"这个假设：换成固定密钥，外键仍然过不了。
    const fixed = await nail({ sessionKey: Buffer.alloc(32, 3) })
    const fixedPlatform = signatureUnder(PLATFORM_SIGNING_KEY, fixed.fingerprint)
    expect(fixed.binding.verifySignature(fixed.fingerprint, fixedPlatform)).toBe(false)
    expect(fixed.binding.verifySignature(fixed.fingerprint, fixed.mapped.signature)).toBe(true)

    // ⑤ 密钥不出进程：另一个本进程实例（另一把密钥）同样不承认本实例的签名，反之亦然。
    const other = await nail({ sessionKey: Buffer.alloc(32, 4) })
    expect(other.binding.verifySignature(fingerprint, mapped.signature)).toBe(false)
    expect(binding.verifySignature(other.fingerprint, other.mapped.signature)).toBe(false)
    // 而且 binding 上没有任何可以复制给平台的密钥材料。
    expect(Object.keys(binding)).not.toContain('sessionKey')
    expect(binding.digest).toBe(ISOLATED_INLINE_SESSION_DIGEST)
  })

  it('自签必过：本进程自签的 offer 通过（今天就是自签自验）', async () => {
    const { binding, mapped, assignment, fingerprint, port } = await nail()

    expect(mapped.signature).toMatch(/^[a-f0-9]{64}$/u)
    // ① 直接验签面。
    expect(binding.verifySignature(fingerprint, mapped.signature)).toBe(true)
    // ② 产品的真实读法（`leaseOf()` 提供 digest，正是 AT-04..06 修掉的那条路径）。
    await expect(verifyTaskAssignment(assignment, mapped.signature, binding.verifySignature))
      .resolves.toMatchObject({ verified: true, assignmentFingerprint: fingerprint })
    // ③ 准入边界：同一个帧、同一个端口，只是签名换成本进程自己刚签的那一份 ⇒ 过。
    await expect(port.verifyOffer(request(mapped, mapped.signature)))
      .resolves.toMatchObject({ accepted: true })
  })

  /**
   * 把上面两条的**唯一区别**固定下来：除了"谁签的"，其余字段逐字相同。
   *
   * 这条断言的作用是防止将来有人把两条钉子改得不再并排（例如给"他签"那条多加一个前置条件，
   * 于是它拒的原因不再是签名本身）—— 那时本用例会红。
   */
  it('两条钉子之间唯一的区别就是签名出自谁手', async () => {
    const { mapped, assignment, fingerprint } = await nail()
    const platformSignature = signatureUnder(PLATFORM_SIGNING_KEY, fingerprint)
    const selfSignature = mapped.signature

    expect(platformSignature).not.toBe(selfSignature)
    // 覆盖的事实逐字相同：同一份 assignment、同一个指纹。
    expect(assignmentFingerprint(assignment)).toBe(fingerprint)
    expect(request(mapped, selfSignature).offer).toEqual({ ...request(mapped, platformSignature).offer, signature: selfSignature })
    // 两串签名形态完全一样（64 位小写十六进制）：从字节上看不出哪一份是"平台的"，
    // 唯一的区别是**谁持有**那把密钥 —— 而那一把从不离开本进程。
    expect(selfSignature).toMatch(/^[a-f0-9]{64}$/u)
    expect(platformSignature).toMatch(/^[a-f0-9]{64}$/u)
  })
})
