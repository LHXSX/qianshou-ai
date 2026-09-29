/**
 * 上游号池：往凭据文件的 `refs:` 段里加一个 Cursor 号，并记住它是谁、什么时候验过。
 *
 * ## 存储形状（已定，照做）
 *
 * - **号池每个号 = `.credentials.yaml` 的 `refs:` 段里一个 ref**，
 *   名字是 `CURSOR_CK_<sha256(authId) 前 8 位>`（见 `poolRefForAuthId`）。
 *   因此号池**不引入第二种存储**：工作台的凭据插件照旧加载同一个文件。
 * - **值存归一化后的 `crsr_…` API key**：69 字符、不过期、无冒号、无引号，
 *   是 YAML 裸标量安全值（会话 JWT 会过期，`userId::jwt` 带冒号会被解析器当成映射）。
 * - **标签/状态/最后验证时间落管理台数据目录**（`pool.json`，`0600`），
 *   与 `upstream-key-meta.ts` 同一套做法。**绝不往凭据文件加顶层键** ——
 *   凭据解析器拒绝未知顶层键，写坏了工作台下次启动就加载不了凭据插件。
 *
 * ## 为什么判重是三条判据、而不是"名字一样就算重复"
 *
 * 只比名字/身份会漏掉一种真实情形：**同一枚 key 已经躺在池子里**（例如运营把同一枚
 * `crsr_…` 又贴了一次，而元数据里那条记录丢了或没写全）。反过来只比值又会漏掉
 * "同一个 Cursor 账号换了一枚新 key"。所以三条各自成立：
 *
 * | 判据 | 命中意味着 | 它挡住的场景 |
 * | --- | --- | --- |
 * | 值相同 | 同一把 key 必然是同一个号 | 元数据损坏/缺失时的重复入库（**最硬**） |
 * | ref 名相同 | 同一个 `authId`（ref 由它派生） | 同一个账号换新 key → 按"替换"处理 |
 * | `authId` 相同 | 元数据里的身份相同 | ref 命名规则变过、或历史 ref 手工改过 |
 *
 * ## 元数据不可信也不影响判重
 *
 * 值的比较用的是**凭据文件里的真实内容**（读进内存后逐字节比），不是元数据里的指纹。
 * 这样"判重"这件事的可靠性不依赖 `pool.json` 是否完好。
 */
import { createJsonStore } from './store.ts'
import {
  CredentialsDocumentError,
  fingerprintOf,
  refRejectionReason,
  valueRejectionReason,
} from './upstream-keys.ts'
import {
  cursorProbeEndpoint,
  isCursorPoolRef,
  normalizeCursorCredential,
  poolRefForAuthId,
  verifyCursorCredential,
  type CursorCredentialShape,
  type CursorDeps,
  type CursorIdentity,
} from './cursor-credential.ts'
import { probeUpstreamKey, type ProbeFailureKind } from './connectivity.ts'

/** 一个号池条目的管理面元数据（**只在管理台自己的数据目录里**）。 */
export interface PoolEntryMeta {
  readonly ref: string
  /** 给人看的标签（如"客服号-1"）；空串表示没起名。 */
  readonly label: string
  /** 落盘值的指纹（sha256 前 8 位）。**明文永不落管理台数据目录**。 */
  readonly fingerprint: string
  /** Cursor 账号标识（ref 由它派生）。 */
  readonly authId: string
  /** 账号邮箱（运维对账要看的；@ 之后的域不是秘密，账号本身管理台本来就能查）。 */
  readonly email: string | null
  /** 这枚号当初是哪种形态进来的（排查归一化问题时要看）。 */
  readonly shape: CursorCredentialShape
  readonly addedAt: number
  readonly addedBy: string
  /** 最近一次验活成功（或替换）的时刻。 */
  readonly lastVerifiedAt: number
  /** 上一次落盘值的指纹；首次写入为 `null`。 */
  readonly previousFingerprint: string | null
}

/**
 * 号池里"已经存在的东西"：**值的真身来自凭据文件**，元数据只是补充。
 *
 * `value` 为 `null` 表示元数据还在、但凭据文件里那一行已经没了（有人手工删过）。
 * 这种条目必须能被看见，否则界面会显示一个"看起来还在、实际已经不在"的号。
 */
export interface PoolExistingEntry {
  readonly ref: string
  readonly value: string | null
  readonly fingerprint: string | null
  readonly authId: string | null
  readonly email: string | null
  readonly label: string
}

/** 候选（准备进池的那一枚）。 */
export interface PoolCandidate {
  readonly ref: string
  /**
   * 将要落盘的 `crsr_…`，**`null` 表示"写入时才会确定"**。
   *
   * 预览阶段不铸新 key（见 `PoolStore.prepare` 的 `mode`），所以会话形态的候选在预览里
   * 只有 ref 与身份，没有值 —— 于是也没有"落盘指纹"可报。宁可报 `null`，也不报一个
   * 写入时会被换掉的指纹（那正是两步确认要防的"预览看到 A、执行的是 B"）。
   */
  readonly value: string | null
  readonly authId: string
  readonly email: string | null
  readonly label: string
}

/** 这次操作对号池的影响。 */
export type PoolAction = 'add' | 'duplicate' | 'replace'

/** 判重命中的是哪一条判据。 */
export type DuplicateBasis = 'value' | 'ref' | 'auth_id'

/** 一次变更计划。 */
export interface PoolChangePlan {
  readonly action: PoolAction
  /** 命中判据（`action` 为 `duplicate` / `replace` 时必有）。 */
  readonly basis: DuplicateBasis | null
  /** 命中的已有 ref（新增时为 `null`）。 */
  readonly existingRef: string | null
  /**
   * 预览里展示的"改之前"指纹。
   *
   * ⚠️ 它**只用于预览**：真正落盘的"旧指纹"一律以 `writeKey` 的返回值为准
   * （它读的是磁盘上的真实内容），因为元数据可能已经过期。
   */
  readonly previousFingerprint: string | null
}

/** 探测**通过**的结论。 */
export type PoolProbeSuccess = {
  readonly ok: true
  readonly latencyMs: number
  /** 打的是哪个（哪几个）接口 —— API key 形态是两步，必须说出来。 */
  readonly endpoint: string
  /** 上游回的 HTTP 状态码（审计要能回答"当时真的是 200 吗"）。 */
  readonly status: number
}

/** 对**将要落盘的那把值**的探测结论（与 §8.7 同一张四类表）。 */
export type PoolProbe =
  | PoolProbeSuccess
  | { readonly ok: false; readonly kind: ProbeFailureKind; readonly message: string; readonly status: number | null }

/**
 * 判据的中文说法。
 *
 * 必须能一句话回答"为什么算同一个号"：三种判据的可信度不一样（值相同最硬、
 * `authId` 相同依赖元数据完好），把它们都说成"重复了"等于把证据的强度抹平。
 * @param basis - 判据。
 * @returns 可直接展示的中文说法。
 */
export function duplicateBasisLabel(basis: DuplicateBasis | null): string {
  if (basis === 'value') return '密钥本身相同（同一把 key 必然是同一个号）'
  if (basis === 'ref') return 'ref 名相同（同一个 Cursor 账号）'
  if (basis === 'auth_id') return 'authId 相同（元数据里的身份相同）'
  return '未知判据'
}

/** 号池准备结果。 */
export type PoolPreparation =
  | {
    readonly ok: true
    readonly shape: CursorCredentialShape
    readonly identity: CursorIdentity
    readonly candidate: PoolCandidate
    /**
     * 落盘值在这次准备里是否已经确定。
     *
     * `false` = 会话形态，写入时才归化成一把新 key。界面据此决定"要不要显示指纹"
     * （不确定就别显示，而不是显示一个会变的）。
     */
    readonly valueKnown: boolean
    /**
     * 探测结论。**主体随模式变**：
     * - `mode: 'preview'` → 探的是**输入凭据**（对 `crsr_…` 输入而言它就是落盘值）；
     * - `mode: 'commit'` → 探的是**将要落盘的那把值**。
     *
     * 刻意允许它是失败（`ok: false`）：预览要把"这枚凭据现在通不通"如实摆给管理员看，
     * 但**强制点是 commit** —— 预览可以被绕过，写入前的探测不能。与 §8.7 同一个取舍。
     */
    readonly probe: PoolProbe
    readonly plan: PoolChangePlan
  }
  /** 形状/标签/键名/值不合规 —— 请求本身有问题，不该动盘也不该打上游。 */
  | { readonly ok: false; readonly code: 'invalid_input'; readonly message: string }
  /** 凭据文件的文档结构读不懂：宁可不改，也不写坏工作台。 */
  | { readonly ok: false; readonly code: 'credentials_unreadable'; readonly message: string }
  /**
   * 上游那两个动作（验活、归一化）没能给出一个可落盘的结果。
   *
   * 两种情形共用它：**验活失败**（连 `authId` 都没有 → 连 ref 都说不出来）与
   * **归一化失败**（身份有了，但没换来可落盘的值）。两边的 `kind` 都照 §8.7 的四类表，
   * 所以对管理员来说建议是一致的：分类不同则下一步不同。
   */
  | { readonly ok: false; readonly code: 'upstream_failed'; readonly kind: ProbeFailureKind; readonly message: string; readonly status: number | null }

/** 列表里的一个号。 */
export interface PoolKeyView {
  readonly ref: string
  /** `active` = 凭据文件里有值；`missing` = 只剩元数据（有人手工删过那一行）。 */
  readonly status: 'active' | 'missing'
  readonly label: string
  readonly fingerprint: string | null
  readonly lastVerifiedAt: number | null
  readonly authId: string | null
  readonly email: string | null
  readonly addedAt: number | null
  readonly addedBy: string | null
  readonly previousFingerprint: string | null
  readonly shape: CursorCredentialShape | null
}

/** 读凭据文件的结果。 */
export type PoolSnapshot =
  | { readonly ok: true; readonly entries: readonly PoolExistingEntry[] }
  | { readonly ok: false; readonly problem: { readonly code: string; readonly message: string } }

/** 号池存储句柄。 */
export interface PoolStore {
  /** 元数据文件路径（运维与审计要用）。 */
  readonly metadataPath: string
  /** 读当前号池（真值来自凭据文件）。 */
  readonly snapshot: () => Promise<PoolSnapshot>
  /** 交给接口的视图。 */
  readonly list: () => Promise<{
    readonly keys: readonly PoolKeyView[]
    readonly fileError: { readonly code: string; readonly message: string } | null
  }>
  /** 把一枚粘贴进来的凭据准备成"可进池的候选"（形态 → 剥包装 → 验活 → 归一化 → 判重）。 */
  readonly prepare: (input: {
    readonly credential: string
    readonly label: string
    /**
     * 这一步是**预览**还是**执行**。
     *
     * - `preview`（`pool/preflight`）：只验活 + 取身份，**绝不铸新 key** —— 预览不能产生
     *   持久副作用，也不能给出一个"写入时会被换掉"的落盘指纹；
     * - `commit`（`pool/apply`）：验活 + 归一化 + 对**将要落盘的那把值**再探一次。
     */
    readonly mode: 'preview' | 'commit'
  }) => Promise<PoolPreparation>
  /** 记一次变更。 */
  readonly record: (entry: PoolEntryMeta) => Promise<void>
  /** 忘掉一个号（凭据文件里那一行已经被删掉之后调用）。 */
  readonly forget: (ref: string) => Promise<void>
}

/** 标签上限：它是给人看的，不是第二套身份。 */
const LABEL_MAX_LENGTH = 64

/**
 * 标签是否可用。
 *
 * 为什么允许空串：号池的**身份**是 ref（由 `authId` 派生），标签只是备注。
 * 强制起名只会让运营随手敲一个"1"。
 * @param label - 标签。
 * @returns 可用返回 `null`，否则返回可直接展示的原因。
 */
export function labelRejectionReason(label: string): string | null {
  if (label.length > LABEL_MAX_LENGTH) return `标签过长（上限 ${LABEL_MAX_LENGTH} 字符）。`
  if (/[\u0000-\u001f\u007f]/.test(label)) return '标签不能包含控制字符。'
  return null
}

/**
 * 判重：这条候选与池子里已有的号是不是同一个。
 * @param candidate - 候选。
 * @param existing - 池子里已有的（值与身份都来自凭据文件）。
 * @returns 变更计划。
 */
export function planPoolChange(
  candidate: PoolCandidate,
  existing: readonly PoolExistingEntry[],
): PoolChangePlan {
  const hit = (action: PoolAction, basis: DuplicateBasis, entry: PoolExistingEntry): PoolChangePlan => ({
    action,
    basis,
    existingRef: entry.ref,
    previousFingerprint: entry.fingerprint,
  })

  const sameValue = candidate.value === null
    ? undefined
    // 判据三（最硬）：值相同。在**凭据文件的真实内容**上逐字节比，与元数据是否完好无关。
    // 同一把 key 必然是同一个号 —— 这条判据不需要任何身份信息就能成立。
    : existing.find(entry => entry.value !== null && entry.value === candidate.value)
  if (sameValue !== undefined) return hit('duplicate', 'value', sameValue)

  // 判据二：ref 名相同。ref 由 authId 派生，所以它等价于"同一个 Cursor 账号"；
  // 值不同说明这个号换了一枚新 key —— 那是**替换**，不是重复入库。
  const sameRef = existing.find(entry => entry.ref === candidate.ref)
  if (sameRef !== undefined) {
    return sameRef.value === candidate.value ? hit('duplicate', 'ref', sameRef) : hit('replace', 'ref', sameRef)
  }

  // 判据一：authId 相同。名字规则变过、或历史 ref 被手工改过时，只有它还能认出来。
  const sameAuth = existing.find(entry => entry.authId !== null && entry.authId === candidate.authId)
  if (sameAuth !== undefined) {
    return sameAuth.value === candidate.value ? hit('duplicate', 'auth_id', sameAuth) : hit('replace', 'auth_id', sameAuth)
  }

  return { action: 'add', basis: null, existingRef: null, previousFingerprint: null }
}

/** 元数据文件形状。 */
interface PoolFile {
  readonly version: 1
  readonly entries: Readonly<Record<string, PoolEntryMeta>>
}

/** 一条元数据记录是否可信（坏记录当成没有，**不猜**）。 */
function isMeta(value: unknown): value is PoolEntryMeta {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row['ref'] === 'string'
    && typeof row['label'] === 'string'
    && typeof row['fingerprint'] === 'string'
    && typeof row['authId'] === 'string'
    && (row['email'] === null || typeof row['email'] === 'string')
    && typeof row['shape'] === 'string'
    && typeof row['addedAt'] === 'number'
    && typeof row['addedBy'] === 'string'
    && typeof row['lastVerifiedAt'] === 'number'
    && (row['previousFingerprint'] === null || typeof row['previousFingerprint'] === 'string')
}

/** 整个元数据文件的形状校验：坏文件当成空，**不猜**。 */
function validatePoolFile(raw: unknown): PoolFile | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  if (row['version'] !== 1) return null
  const entries = row['entries']
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return null
  const out: Record<string, PoolEntryMeta> = {}
  for (const [ref, value] of Object.entries(entries as Record<string, unknown>)) {
    // 键名与记录里的 ref 不一致时按"不认识"处理：那种文件说不清是谁的。
    if (isMeta(value) && value.ref === ref) out[ref] = value
  }
  return { version: 1, entries: out }
}

/**
 * 建号池存储。
 * @param options - 读凭据文件的方法、元数据文件路径、上游依赖与时钟。
 * @returns 句柄。
 */
export function createPool(options: {
  /** 读凭据文件 `refs:` 段（`UpstreamKeyStore.readEntries`）。文档坏了要抛 `CredentialsDocumentError`。 */
  readonly entries: () => Promise<ReadonlyMap<string, string>>
  /** 元数据文件路径（管理台数据目录内）。 */
  readonly metadataPath: string
  /**
   * 上游依赖（测试注入）。
   *
   * 与 §8.7 的连通性探测共用同一份依赖：号池的验活/归一化与探测走的是**同一个 fetch**，
   * 否则测试里会出现"一半打桩、一半真打网络"的缝。
   */
  readonly upstream?: CursorDeps
}): PoolStore {
  const upstream = options.upstream ?? {}
  const store = createJsonStore<PoolFile>({
    path: options.metadataPath,
    defaults: () => ({ version: 1, entries: {} }),
    validate: validatePoolFile,
  })

  const snapshot = async (): Promise<PoolSnapshot> => {
    let entries: ReadonlyMap<string, string>
    try {
      entries = await options.entries()
    } catch (error) {
      const problem = error instanceof CredentialsDocumentError
        ? { code: error.code, message: error.message }
        : { code: 'unreadable', message: error instanceof Error ? error.message : String(error) }
      return { ok: false, problem }
    }
    const meta = (await store.load()).entries
    // 只认号池的 ref：网关自己的密钥（`DEEPSEEK_API_KEY` 之类）不属于号池。
    const refs = [...new Set([...entries.keys(), ...Object.keys(meta)])].filter(isCursorPoolRef).sort()
    return {
      ok: true,
      entries: refs.map((ref) => {
        const value = entries.get(ref) ?? null
        const record = meta[ref]
        return {
          ref,
          value,
          fingerprint: value === null ? (record?.fingerprint ?? null) : fingerprintOf(value),
          authId: record?.authId ?? null,
          email: record?.email ?? null,
          label: record?.label ?? '',
        }
      }),
    }
  }

  /** 把号池条目拼成接口视图。 */
  const viewsOf = async (entries: readonly PoolExistingEntry[]): Promise<readonly PoolKeyView[]> => {
    const meta = (await store.load()).entries
    return entries.map((entry) => {
      const record = meta[entry.ref]
      return {
        ref: entry.ref,
        status: entry.value === null ? 'missing' as const : 'active' as const,
        label: entry.label,
        fingerprint: entry.fingerprint,
        lastVerifiedAt: record?.lastVerifiedAt ?? null,
        authId: entry.authId,
        email: entry.email,
        addedAt: record?.addedAt ?? null,
        addedBy: record?.addedBy ?? null,
        previousFingerprint: record?.previousFingerprint ?? null,
        shape: record?.shape ?? null,
      }
    })
  }

  return {
    metadataPath: options.metadataPath,
    snapshot,

    list: async () => {
      const current = await snapshot()
      if (!current.ok) return { keys: [], fileError: current.problem }
      return { keys: await viewsOf(current.entries), fileError: null }
    },

    prepare: async ({ credential, label, mode }) => {
      const labelProblem = labelRejectionReason(label)
      if (labelProblem !== null) return { ok: false, code: 'invalid_input', message: labelProblem }

      // 第一步：验活 + 取身份。**两种模式都做**，且都不铸 key。
      const verified = await verifyCursorCredential(credential, upstream)
      if (!verified.ok) {
        if (verified.code === 'unrecognized') return { ok: false, code: 'invalid_input', message: verified.message }
        return { ok: false, code: 'upstream_failed', kind: verified.kind, message: verified.message, status: verified.status }
      }

      // ref 由 authId 派生；它必须过凭据体系那两条既有校验（**复用，不另写一套**）。
      const ref = poolRefForAuthId(verified.identity.authId)
      const refProblem = refRejectionReason(ref)
      if (refProblem !== null) return { ok: false, code: 'invalid_input', message: `派生出来的键名「${ref}」不可用：${refProblem}` }

      /**
       * 第二步：`commit` 才归一化。
       *
       * 归一化是**对 Cursor 账号的持久副作用**（铸一把新 key），所以预览绝不碰它；
       * 也因此预览里的候选可能没有落盘值（`value: null`），界面据 `valueKnown` 决定
       * 要不要显示指纹 —— 显示一个写入时会被换掉的指纹比不显示更糟。
       */
      let value: string | null = verified.reading.shape === 'api-key' ? verified.reading.bearer : null
      if (mode === 'commit') {
        const normalized = await normalizeCursorCredential(verified.reading, upstream)
        if (!normalized.ok) {
          return { ok: false, code: 'upstream_failed', kind: normalized.kind, message: normalized.message, status: normalized.status }
        }
        value = normalized.value.value
      }
      if (value !== null) {
        const valueProblem = valueRejectionReason(value)
        if (valueProblem !== null) {
          return {
            ok: false,
            code: 'invalid_input',
            message: `将要落盘的值不能安全落盘：${valueProblem}（号池只存裸标量，不存带冒号的 userId::jwt）`,
          }
        }
      }

      const current = await snapshot()
      if (!current.ok) {
        return { ok: false, code: 'credentials_unreadable', message: `凭据文件读不懂，为免写坏它已拒绝操作：${current.problem.message}` }
      }

      const candidate: PoolCandidate = {
        ref,
        value,
        authId: verified.identity.authId,
        email: verified.identity.email,
        label,
      }
      const plan = planPoolChange(candidate, current.entries)

      /**
       * 探测。
       *
       * - 预览：上一步的验活就是结论（API key 形态下它打的就是落盘值本身）；
       * - 执行：**对将要落盘的那把值再探一次** —— 会话形态下刚铸出来的 key 必须自己再验一次
       *   （输入的 JWT 有效不等于铸出来的 key 可用），这是"写前探测"这条硬要求的强制点；
       * - **API key 形态不必重复**：落盘值就是刚才验过的那一串，再打一次只是两次一模一样的
       *   上游调用（每次还是"换票 + 取身份"两步）。所以只在值确实变了的时候才补探。
       */
      const needsValueProbe = mode === 'commit' && value !== null && value !== verified.reading.bearer
      const probe: PoolProbe = needsValueProbe
        // 此刻的落盘值恒为 `crsr_…`（会话形态刚铸出来的），所以探测走两步：换票 → 取身份。
        ? toPoolProbe(await probeUpstreamKey(ref, value as string, upstream), 'api-key')
        : {
          ok: true,
          latencyMs: verified.probe.latencyMs,
          endpoint: cursorProbeEndpoint(verified.reading.shape),
          status: verified.probe.status,
        }

      return {
        ok: true,
        shape: verified.reading.shape,
        identity: verified.identity,
        candidate,
        valueKnown: value !== null,
        probe,
        plan,
      }
    },
    record: async (entry) => {
      const current = await store.load()
      await store.save({ version: 1, entries: { ...current.entries, [entry.ref]: entry } })
    },

    forget: async (ref) => {
      const current = await store.load()
      if (current.entries[ref] === undefined) return
      const next: Record<string, PoolEntryMeta> = {}
      for (const [key, value] of Object.entries(current.entries)) {
        if (key !== ref) next[key] = value
      }
      await store.save({ version: 1, entries: next })
    },
  }
}

/**
 * 把连通性探测的结论映射成号池的探测视图。
 * @param result - 连通性探测结果。
 * @param shape - 被探测值的形态（决定"打了哪个接口"的说法）。
 * @returns 号池视角的探测结论。
 */
function toPoolProbe(
  result: Awaited<ReturnType<typeof probeUpstreamKey>>,
  shape: CursorCredentialShape,
): PoolProbe {
  const endpoint = cursorProbeEndpoint(shape)
  return result.ok
    ? { ok: true, latencyMs: result.latencyMs, endpoint, status: result.status }
    : { ok: false, kind: result.kind, message: result.message, status: result.status }
}
