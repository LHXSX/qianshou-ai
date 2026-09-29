/**
 * 账本持久化的契约测试。
 *
 * 这个文件守的是一条**钱会漏**的边界：账本原本纯内存，工作台一重启——
 * 部署、改配置、机器重启、崩溃——所有人的月度用量与五小时刹车全部归零。
 * 那不是"少记一笔"，而是"月度上限根本没拦"：用户等到重启就能无限重置额度。
 *
 * 这里用真实临时目录读写文件，不做内存替身：如果只测"调了 snapshot 函数"，
 * 恰好会漏掉 JSON 序列化、单位换算、以及原子替换这三处真正会出错的地方。
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCreditLedger, MICRO_SP_PER_SP } from '../src/ledger.ts'
import { createLedgerStore, LEDGER_STORE_FILENAME, type LedgerSnapshot } from '../src/persistence.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.allSettled(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** 建一个临时账本文件路径。 */
async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-ledger-'))
  dirs.push(dir)
  return join(dir, LEDGER_STORE_FILENAME)
}

/** 把账本接到持久化层，返回两者。 */
async function wired(): Promise<{
  readonly ledger: ReturnType<typeof createCreditLedger>
  readonly store: ReturnType<typeof createLedgerStore>
  readonly path: string
}> {
  const path = await tempPath()
  // 先把 store 的位置留出来，再建账本：账本要在变更时通知它。
  // 只建**一个**账本实例——建两个会变成"改的是 A、存的是 B"，测试会全绿地骗过去。
  const holder: { store?: ReturnType<typeof createLedgerStore> } = {}
  const ledger = createCreditLedger({ onChange: () => { holder.store?.markDirty() } })
  const store = createLedgerStore({ path, snapshot: () => ledger.snapshotOf(), coalesceMs: 0 })
  holder.store = store
  return { ledger, store, path }
}

/** 模拟一次"重启"：新账本 + 新持久化层，从同一个文件读回。 */
async function restart(path: string): Promise<ReturnType<typeof createCreditLedger>> {
  const ledger = createCreditLedger()
  const store = createLedgerStore({ path, snapshot: () => ledger.snapshotOf() })
  const snapshot = await store.load()
  if (snapshot !== null) ledger.restore(snapshot)
  return ledger
}

describe('账本持久化：重启不能让额度归零', () => {
  it('花掉的钱在重启后仍然被记住（这是月度上限成立的前提）', async () => {
    const { ledger, store, path } = await wired()
    ledger.grant('a', 'basic', 390)
    ledger.reserve({ callId: 'c1', accountId: 'a', sp: 3.47 })
    ledger.settle({ callId: 'c1', sp: 0.07 })
    await store.flush()
    expect(ledger.creditOf('a', 'basic').remainingMonthlySp).toBe(389.93)

    const after = await restart(path)
    expect(after.creditOf('a', 'basic').remainingMonthlySp).toBe(389.93)
  })

  it('五小时刹车跨重启仍然有效（否则重启就是重置滥用的开关）', async () => {
    const { ledger, store, path } = await wired()
    ledger.grant('a', 'basic', 390)
    for (let index = 0; index < 5; index += 1) {
      const callId = `c-${index}`
      ledger.reserve({ callId, accountId: 'a', sp: 0.07 })
      ledger.settle({ callId, sp: 0.07 })
    }
    await store.flush()

    const after = await restart(path)
    expect(after.creditOf('a', 'basic').usedInWindowSp).toBe(0.35)
  })

  it('未结算的预留也要恢复：否则重启放出虚高余额，并发请求会超发', async () => {
    const { ledger, store, path } = await wired()
    ledger.grant('a', 'basic', 100)
    ledger.reserve({ callId: 'inflight', accountId: 'a', sp: 50 })
    await store.flush()
    expect(ledger.creditOf('a', 'basic').remainingMonthlySp).toBe(50)

    const after = await restart(path)
    // 那笔在飞请求还没结算，它占住的额度必须还在。
    expect(after.creditOf('a', 'basic').remainingMonthlySp).toBe(50)
    // 结算仍然能对上：重启不该让一笔预留变成孤儿。
    expect(after.settle({ callId: 'inflight', sp: 0.07 }).remainingSp).toBe(99.93)
  })

  it('审计记录跨重启保留（对账要能回溯）', async () => {
    const { ledger, store, path } = await wired()
    ledger.grant('a', 'basic', 390)
    ledger.reserve({ callId: 'c1', accountId: 'a', sp: 1 })
    ledger.settle({
      callId: 'c1',
      sp: 0.07,
      call: { tier: 'basic', publishedName: '千手·迅捷', backendKey: 'deepseek-flash', inputTokens: 120, outputTokens: 40 },
    })
    await store.flush()

    const after = await restart(path)
    const records = after.recordsOf('a', 10)
    expect(records.length).toBe(1)
    expect(records[0]?.inputTokens).toBe(120)
    expect(records[0]?.outputTokens).toBe(40)
    expect(records[0]?.publishedName).toBe('千手·迅捷')
  })

  it('落盘用整数微 SP，读回来不丢精度', async () => {
    // 必须用接好变更通知的版本：账本的结算是**同步**的，落盘只能靠 onChange 打标记。
    const { ledger, store, path } = await wired()
    ledger.grant('a', 'basic', 1)
    ledger.reserve({ callId: 'c1', accountId: 'a', sp: 0.07 })
    ledger.settle({ callId: 'c1', sp: 0.07 })
    await store.flush()

    const raw = JSON.parse(await readFile(path, 'utf8')) as LedgerSnapshot
    // 0.07 SP 必须以 70000 微 SP 存下来，而不是 0.07000000000000001 这样的浮点尾巴。
    expect(raw.records[0]?.microSp).toBe(Math.round(0.07 * MICRO_SP_PER_SP))
    expect(raw.grants[0]?.microSp).toBe(MICRO_SP_PER_SP)
  })

  it('文件不存在时返回空快照，而不是抛错', async () => {
    const empty = (): LedgerSnapshot => ({ version: 1, savedAt: 0, grants: [], partialCharges: [], reservations: [], records: [] })
    const store = createLedgerStore({ path: await tempPath(), snapshot: empty })
    await expect(store.load()).resolves.toBeNull()
  })

  it('文件损坏时当作没有快照，而不是让工作台起不来', async () => {
    const path = await tempPath()
    await writeFile(path, '{ 这不是 JSON', 'utf8')
    const ledger = createCreditLedger()
    const store = createLedgerStore({ path, snapshot: () => ledger.snapshotOf() })
    // 坏文件必须被安静地忽略：账本从零开始，工作台照常可用。
    await expect(store.load()).resolves.toBeNull()
  })

  it('版本号不认识时拒绝恢复（避免按错的结构记账）', async () => {
    const path = await tempPath()
    await writeFile(path, JSON.stringify({ version: 99, savedAt: 0, grants: [], reservations: [], records: [] }), 'utf8')
    const ledger = createCreditLedger()
    const store = createLedgerStore({ path, snapshot: () => ledger.snapshotOf() })
    await expect(store.load()).resolves.toBeNull()
  })

  it('多个账号各自独立恢复', async () => {
    const { ledger, store, path } = await wired()
    ledger.grant('a', 'basic', 390)
    ledger.grant('b', 'plus', 990)
    ledger.reserve({ callId: 'ca', accountId: 'a', sp: 1 })
    ledger.settle({ callId: 'ca', sp: 0.07 })
    await store.flush()

    const after = await restart(path)
    expect(after.creditOf('a', 'basic').remainingMonthlySp).toBe(389.93)
    expect(after.creditOf('b', 'plus').remainingMonthlySp).toBe(990)
  })

  it('恢复之后继续扣减，账是接着算的', async () => {
    const { ledger, store, path } = await wired()
    ledger.grant('a', 'basic', 390)
    ledger.reserve({ callId: 'c1', accountId: 'a', sp: 1 })
    ledger.settle({ callId: 'c1', sp: 0.07 })
    await store.flush()

    const after = await restart(path)
    after.reserve({ callId: 'c2', accountId: 'a', sp: 1 })
    after.settle({ callId: 'c2', sp: 0.07 })
    expect(after.creditOf('a', 'basic').remainingMonthlySp).toBe(389.86)
  })
})

describe('字段校验：改一行文件不能改余额（WP1 A-10）', () => {
  /** 一份形状合法的最小快照，供各条测试改坏一个字段。 */
  const good = {
    version: 1,
    savedAt: 1,
    grants: [{ accountId: 'a', tier: 'basic', microSp: 1_000_000, periodStart: 0 }],
    partialCharges: [],
    reservations: [],
    records: [],
  }

  /** 把一份快照写进临时文件，并只做读取。 */
  async function loadRaw(value: unknown): Promise<LedgerSnapshot | null> {
    const path = await tempPath()
    await writeFile(path, JSON.stringify(value), 'utf8')
    const ledger = createCreditLedger()
    return await createLedgerStore({ path, snapshot: () => ledger.snapshotOf() }).load()
  }

  it('合法快照照常读回', async () => {
    const snapshot = await loadRaw(good)
    expect(snapshot?.grants[0]?.microSp).toBe(1_000_000)
  })

  it('余额字段是字符串时整份拒绝（"改一行就能改余额"的直接防线）', async () => {
    // 注意 `Number.isSafeInteger`：只判 `typeof x === 'number'` 挡不住 NaN，而 NaN 会让
    // 余额变成 NaN，比较一律为假 ⇒ 额度判定全部放行。
    expect(await loadRaw({ ...good, grants: [{ accountId: 'a', tier: 'basic', microSp: '999999999', periodStart: 0 }] })).toBeNull()
  })

  it('余额是 NaN / 负数 / 小数 / 超出安全整数时一并拒绝', async () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(await loadRaw({ ...good, grants: [{ accountId: 'a', tier: 'basic', microSp: bad, periodStart: 0 }] })).toBeNull()
    }
  })

  it('档位不是已知档位时拒绝（否则 TIERS[bad] 是 undefined，会在别处炸）', async () => {
    expect(await loadRaw({ ...good, grants: [{ accountId: 'a', tier: 'unlimited', microSp: 1, periodStart: 0 }] })).toBeNull()
  })

  it('缺字段 / 空 id / 记录里带负 token 数都拒绝', async () => {
    expect(await loadRaw({ ...good, grants: [{ accountId: '', tier: 'basic', microSp: 1, periodStart: 0 }] })).toBeNull()
    expect(await loadRaw({ ...good, savedAt: undefined })).toBeNull()
    expect(await loadRaw({
      ...good,
      records: [{
        callId: 'c', accountId: 'a', tier: 'basic', publishedName: 'x', backendKey: 'flash',
        at: 1, inputTokens: -5, outputTokens: 0, microSp: 1,
      }],
    })).toBeNull()
  })
})

describe('完整性密钥：写了 MAC 就要验（WP1 A-10）', () => {
  /** 用同一把密钥写出快照，返回文件路径。 */
  async function signed(key: string): Promise<string> {
    const path = await tempPath()
    const holder: { store?: ReturnType<typeof createLedgerStore> } = {}
    const ledger = createCreditLedger({ onChange: () => { holder.store?.markDirty() } })
    const store = createLedgerStore({ path, macKey: key, coalesceMs: 0, snapshot: () => ledger.snapshotOf() })
    holder.store = store
    ledger.grant('a', 'basic', 390)
    await store.flush()
    return path
  }

  it('密钥一致时照常读回', async () => {
    const key = 'test-integrity-key'
    const path = await signed(key)
    const ledger = createCreditLedger()
    const store = createLedgerStore({ path, macKey: key, snapshot: () => ledger.snapshotOf() })
    const snapshot = await store.load()
    expect(snapshot?.grants[0]?.microSp).toBe(390 * MICRO_SP_PER_SP)
  })

  it('文件被改过（哪怕只改一个数字）就拒绝，并把原文件挪到旁支留证', async () => {
    const key = 'test-integrity-key'
    const path = await signed(key)
    const raw = JSON.parse(await readFile(path, 'utf8')) as { grants: { microSp: number }[] }
    raw.grants[0]!.microSp = 99_000_000_000
    await writeFile(path, JSON.stringify(raw), 'utf8')

    const ledger = createCreditLedger()
    const store = createLedgerStore({ path, macKey: key, quarantine: true, snapshot: () => ledger.snapshotOf() })
    expect(await store.load()).toBeNull()
    // 原文件被挪走（不删除）：出问题时还能看见被改成什么样。
    const siblings = await readdir(join(path, '..'))
    expect(siblings.some(name => name.startsWith(`${LEDGER_STORE_FILENAME}.rejected-`))).toBe(true)
  })

  it('密钥在场而文件没有 MAC 时也拒绝（否则"删掉 mac"就是新的绕过方式）', async () => {
    const key = 'test-integrity-key'
    const path = await tempPath()
    await writeFile(path, JSON.stringify({ version: 1, savedAt: 1, grants: [], partialCharges: [], reservations: [], records: [] }), 'utf8')
    const ledger = createCreditLedger()
    const store = createLedgerStore({ path, macKey: key, snapshot: () => ledger.snapshotOf() })
    expect(await store.load()).toBeNull()
  })

  it('没配密钥时只做字段校验（如实降级，不假装防篡改）', async () => {
    const path = await tempPath()
    await writeFile(path, JSON.stringify({ version: 1, savedAt: 1, grants: [], partialCharges: [], reservations: [], records: [] }), 'utf8')
    const ledger = createCreditLedger()
    const store = createLedgerStore({ path, snapshot: () => ledger.snapshotOf() })
    await expect(store.load()).resolves.not.toBeNull()
    // 而且不会凭空写一个 mac 字段进文件。
    const empty = (): LedgerSnapshot => ({ version: 1, savedAt: 2, grants: [], partialCharges: [], reservations: [], records: [] })
    const store2 = createLedgerStore({ path, coalesceMs: 0, snapshot: empty })
    store2.markDirty()
    await store2.flush()
    expect(JSON.parse(await readFile(path, 'utf8'))).not.toHaveProperty('mac')
  })
})
