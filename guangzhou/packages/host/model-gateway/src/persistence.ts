/**
 * 额度账本的落盘。
 *
 * 为什么必须有：账本原本是纯内存的。工作台一重启——部署、改配置、机器重启、
 * 甚至崩溃——**所有人的月度用量和五小时刹车都会归零**。那不是"少记一笔"，
 * 而是"月度上限根本没拦"：用户只要等到重启，就能无限重置自己的额度。
 * 订阅要能收钱，前提是账记得住。
 *
 * 形态选择：**全量快照 + 原子替换**，不是追加日志。
 * - 追加日志需要重放与压缩，还要处理"写了一半"；快照是幂等的、可直接读的，
 *   而且这份数据量天然很小（每账号一个授予 + 一段时间内的调用记录）。
 * - 原子替换沿用宿主账号面的既有做法（先写临时文件再 `rename`），
 *   并用 `0600`：账本里有账号 id 与消费记录，不该给别人读。
 *
 * 写入节奏：**合并写**。结算是同步的（网关的判定链要求同步），所以不能在这里
 * `await`。做法是同步地打一个"脏"标记，由一个串行 runner 异步落盘；
 * 反复变更只写最后一次。`flush()` 给测试与关停用，保证能等到真的写完。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isTierId, type TierId } from './tiers.ts'

/** 账本文件名（放在 DSH home 下）。 */
export const LEDGER_STORE_FILENAME = '.qianshou-ledger.json'

/** 落盘格式版本；将来改结构时靠它判断怎么升级。 */
const FORMAT_VERSION = 1

/** 一条授予记录。 */
export interface GrantEntry {
  readonly accountId: string
  readonly tier: TierId
  readonly microSp: number
  readonly periodStart: number
}

/** 一笔**未完成调用**已经产生的扣费。 */
export interface PartialChargeEntry {
  readonly callId: string
  readonly accountId: string
  readonly microSp: number
  readonly at: number
}

/** 一笔未结算的预留。 */
export interface ReservationEntry {
  readonly callId: string
  readonly accountId: string
  readonly tier: TierId
  readonly microSp: number
  readonly at: number
}

/**
 * 一条调用记录（审计）。
 *
 * `tier` 刻意是 `string` 而不是 `TierId`：这是**历史**记录，档位表将来变了也必须能读回旧账。
 */
export interface RecordEntry {
  readonly callId: string
  readonly accountId: string
  readonly tier: string
  readonly publishedName: string
  readonly backendKey: string
  readonly at: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly microSp: number
}

/**
 * 一份账本快照。字段名与账本内部状态一一对应，**不做二次加工**。
 */
export interface LedgerSnapshot {
  readonly version: number
  readonly savedAt: number
  /** 每账号的授予：额度（**微 SP**）与账期起点。 */
  readonly grants: readonly GrantEntry[]
  /**
   * 未完成调用已经产生的扣费。
   *
   * 必须随快照存活：中途断开的调用虽然不写完整记录，但钱已经花了——
   * 重启后如果把它丢掉，那笔费用就等于没发生（正是漏洞的形态）。
   */
  readonly partialCharges: readonly PartialChargeEntry[]
  /** 未结算的预留：进程重启后仍要占住额度，否则并发请求会看到一份虚高的余额。 */
  readonly reservations: readonly ReservationEntry[]
  /** 调用记录（审计）。 */
  readonly records: readonly RecordEntry[]
  /**
   * 整份快照的 HMAC（十六进制）；没配密钥时不写这个字段。
   *
   * 校验范围是**去掉本字段之后的整份 JSON**，所以增加业务字段不影响验签。
   */
  readonly mac?: string
}

/**
 * 账本持久化器。
 *
 * 刻意只做"存/取"，不认识业务：账本该怎么算、谁该被拒，都在 `ledger.ts`。
 */
export interface LedgerStore {
  /** 标记有变更；实际写盘由串行 runner 合并完成。 */
  readonly markDirty: () => void
  /** 等到当前所有变更都落盘（测试与关停用）。 */
  readonly flush: () => Promise<void>
  /** 读回快照；文件不存在或损坏时返回 `null`（**不抛**：坏文件不该让工作台起不来）。 */
  readonly load: () => Promise<LedgerSnapshot | null>
}

/** 校验用的判定：非负安全整数。**不是"能转成数字"就行**。 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 字符串且非空。 */
function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** 取快照里的一个数组字段；不是数组时返回 `null`。 */
function arrayOf(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null
}

/** 取一个对象字段；不是对象（`null`、数组、标量）时返回 `null`。 */
function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * 逐条校验一份快照。
 *
 * 两条纪律（WP1 A-10）：
 *
 * 1. **逐字段校验，不看形状像不像**。早先只检查了"这仨是数组"，于是一个被改过（或被写坏）
 *    的文件能让 `microSp` 变成 `NaN`：`NaN` 参与累加会把**余额**变成 `NaN`，而 `NaN` 的
 *    比较一律为假，最后表现为"额度判定全部放行"——即改一行文件就能改余额。
 * 2. **返回的是重新构造的值，不是原对象**。字段级校验通过之后按声明类型重建，
 *    因此未知字段不会顺着快照漏进内存（`Array.isArray` 的类型谓词是 `arg is any[]`，
 *    依赖它做收窄会让后续校验全部退化成 `any`——这正是"校验在跑、类型却不再帮忙"的形态）。
 *
 * 原则：**字段级别不可信就整份拒绝**。宁可当成"没有账本"，也不接受一份半可信的账。
 * @param raw - 已解析的候选值（`unknown`：它来自磁盘，未经任何保证）。
 * @returns 合法快照，或 `null`。
 */
function validateSnapshot(raw: unknown): LedgerSnapshot | null {
  const source = objectOf(raw)
  if (source === null) return null
  if (source['version'] !== FORMAT_VERSION) return null
  const savedAt = source['savedAt']
  if (!isCount(savedAt)) return null
  const grantRows = arrayOf(source['grants'])
  const partialRows = arrayOf(source['partialCharges'])
  const reservationRows = arrayOf(source['reservations'])
  const recordRows = arrayOf(source['records'])
  if (grantRows === null || partialRows === null || reservationRows === null || recordRows === null) return null

  const grants: GrantEntry[] = []
  for (const row of grantRows) {
    const entry = objectOf(row)
    if (entry === null) return null
    const { accountId, tier, microSp, periodStart } = entry
    if (!isName(accountId) || !isCount(microSp) || !isCount(periodStart) || !isTierId(tier)) return null
    grants.push({ accountId, tier, microSp, periodStart })
  }

  const partialCharges: PartialChargeEntry[] = []
  for (const row of partialRows) {
    const entry = objectOf(row)
    if (entry === null) return null
    const { callId, accountId, microSp, at } = entry
    if (!isName(callId) || !isName(accountId) || !isCount(microSp) || !isCount(at)) return null
    partialCharges.push({ callId, accountId, microSp, at })
  }

  const reservations: ReservationEntry[] = []
  for (const row of reservationRows) {
    const entry = objectOf(row)
    if (entry === null) return null
    const { callId, accountId, tier, microSp, at } = entry
    if (!isName(callId) || !isName(accountId) || !isCount(microSp) || !isCount(at)) return null
    if (!isTierId(tier)) return null
    reservations.push({ callId, accountId, tier, microSp, at })
  }

  const records: RecordEntry[] = []
  for (const row of recordRows) {
    const entry = objectOf(row)
    if (entry === null) return null
    const { callId, accountId, tier, publishedName, backendKey, at, inputTokens, outputTokens, microSp } = entry
    if (!isName(callId) || !isName(accountId) || !isCount(at)) return null
    if (!isCount(microSp) || !isCount(inputTokens) || !isCount(outputTokens)) return null
    // `tier` 是历史值：只要求是非空字符串，不要求它属于今天的档位表。
    if (typeof tier !== 'string' || tier.length === 0) return null
    if (typeof publishedName !== 'string' || typeof backendKey !== 'string') return null
    records.push({ callId, accountId, tier, publishedName, backendKey, at, inputTokens, outputTokens, microSp })
  }

  return { version: FORMAT_VERSION, savedAt, grants, partialCharges, reservations, records }
}

/** 计算一份快照的 MAC；`body` 是**不含** `mac` 字段的整份 JSON 文本。 */
function macOf(key: string, body: string): string {
  return createHmac('sha256', key).update(body).digest('hex')
}

/** 定长比较，避免用比较耗时反推前缀。 */
function sameMac(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * 把文件内容解析成快照。
 *
 * 顺序是刻意的：**先验签、再校验字段**。验签要拿原始文本（重建 JSON 会改变字节），
 * 所以不能先把对象规范化再算 MAC。
 * @param raw - 文件原文。
 * @param macKey - 完整性密钥；未配置时只做字段校验。
 * @returns 快照，或 `null`（任何一项不过都算"没有可用快照"）。
 */
/**
 * 把文件内容解析成快照。
 *
 * 顺序是刻意的：**先验签、再校验字段**。验签要拿原始文本（重建 JSON 会改变字节），
 * 所以不能先把对象规范化再算 MAC。
 * @param raw - 文件原文。
 * @param macKey - 完整性密钥；未配置时只做字段校验。
 * @returns 快照，或 `null`（任何一项不过都算"没有可用快照"）。
 */
function parseSnapshot(raw: string, macKey: string | null): LedgerSnapshot | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  if (macKey !== null) {
    const { mac, ...body } = parsed as Record<string, unknown>
    // 密钥在场而文件没有 MAC：**不能放行**。否则"删掉 mac 字段"就是新的绕过方式。
    if (typeof mac !== 'string') return null
    if (!sameMac(mac, macOf(macKey, JSON.stringify(body)))) return null
  }
  return validateSnapshot(parsed)
}

/**
 * 建一个账本持久化器。
 * @param options - 文件路径、快照来源、合并写窗口与完整性密钥。
 * @returns 持久化器。
 */
export function createLedgerStore(options: {
  readonly path: string
  /** 生成当前快照；每次落盘时调用。 */
  readonly snapshot: () => LedgerSnapshot
  /** 合并写窗口（毫秒）。0 表示每个变更都立刻写。 */
  readonly coalesceMs?: number
  /**
   * 账本完整性密钥（HMAC-SHA256）。
   *
   * 省略时**不写也不验** MAC，只做字段校验——这是刻意的：密钥从哪来是部署方的决定
   * （凭据服务 / 环境变量），我们不在本机凭空造一把再存成文件：那样写下来的密钥与
   * 账本同处一个目录、同一个 OS 用户可读，防的是同一个攻击者，收益接近零。
   */
  readonly macKey?: string
  /** 写了 MAC 却验不过时，把文件挪到带时间戳的旁支（保留证据）；省略时只拒绝、不搬。 */
  readonly quarantine?: boolean
}): LedgerStore {
  const coalesceMs = options.coalesceMs ?? 50
  const macKey = options.macKey === undefined || options.macKey.length === 0 ? null : options.macKey
  let dirty = false
  let running: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const writeOnce = async (): Promise<void> => {
    const value = options.snapshot()
    const body = JSON.stringify(value)
    // MAC 盖在**去掉 mac 的整份 JSON** 上：新增业务字段不需要改验签逻辑。
    const text = macKey === null ? body : JSON.stringify({ ...value, mac: macOf(macKey, body) })
    await mkdir(dirname(options.path), { recursive: true })
    const temp = `${options.path}.tmp`
    await writeFile(temp, `${text}\n`, { mode: 0o600 })
    // 先写临时文件再改名：半个文件写坏会让下次冷启动丢掉整份账本。
    await rename(temp, options.path)
  }

  /** 串行 runner：同一时刻只有一个写盘在跑，跑完再看有没有新变更。 */
  const run = async (): Promise<void> => {
    if (running !== null) {
      await running
      return
    }
    running = (async () => {
      while (dirty) {
        dirty = false
        try {
          await writeOnce()
        } catch {
          // 写盘失败不该让请求失败：账本在内存里仍然是对的，下一次变更会再试。
          // 但要把"脏"标回来，否则这一笔就永远不落盘了。
          dirty = true
          break
        }
      }
    })().finally(() => { running = null })
    await running
  }

  return {
    markDirty: () => {
      dirty = true
      if (coalesceMs === 0) {
        void run()
        return
      }
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        void run()
      }, coalesceMs)
      // 别让这个计时器拖住进程退出（Node 的 Timer 有 `unref`；只有 `setTimeout` 的
      // 返回类型在别处被收窄成 `number` 时才需要判空，这里不需要）。
      timer.unref()
    },
    flush: async () => {
      if (timer !== null) { clearTimeout(timer); timer = null }
      await run()
    },
    load: async () => {
      let raw: string
      try {
        raw = await readFile(options.path, 'utf8')
      } catch {
        // 文件不存在：全新部署，不是"账本坏了"。
        return null
      }
      const snapshot = parseSnapshot(raw, macKey)
      if (snapshot !== null) return snapshot
      /**
       * 走到这里说明**文件在、但不可信**（验签不过或字段非法）。
       *
       * 为什么要把这两种情况分开：文件不存在 = 全新部署；文件在却读不回来 = 要么被改过、
       * 要么写坏了——都需要有人知道。`quarantine` 打开时把原文件挪到带时间戳的旁支
       * （**不删除**）：出问题时还能看见被改成什么样。
       */
      if (options.quarantine === true) {
        await rename(options.path, `${options.path}.rejected-${Date.now()}`).catch(() => { /* 挪不动就留着 */ })
      }
      return null
    },
  }
}
