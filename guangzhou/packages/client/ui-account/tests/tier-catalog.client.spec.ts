/**
 * 档位商品表与服务端的**一致性测试**。
 *
 * ## 它防的是什么
 *
 * 客户端的 `TIER_OFFERS` 抄了服务端 `TIERS` 的五个数字（月费、每月 SP、上下文、
 * 并发）。这五个数字一旦只有一边改，界面就会**对着一个不存在的价格推销**——
 * 而这类错误没有任何运行时报错，只有用户会先去发现。
 *
 * ## 为什么读文本而不是 import
 *
 * `packages/host/model-gateway/src/tiers.ts` 属于 **host 类型程序**（`tsconfig.host.json`），
 * 而这里是 client 程序（`tsconfig.client.json`）。跨程序 import 会把 host 源码拉进
 * client 的编译单元，破坏两边各自合并的 cordis Context，也会让这个包意外依赖宿主。
 * 所以这里把 host 源码**当文本读**，只提取数字。这不是偷懒——
 * 它恰好也证明了"两份数据是各自独立维护的"，那正是要检查的关系。
 *
 * 这个文件路径是**刻意的硬编码**：如果哪天 host 的 tiers 换了位置，
 * 这条测试会以"文件读不到"的形式红掉，那正是我们想要的通知。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TIER_OFFERS, offerOf, spPerYuan } from '../src/client/tiers.ts'

/** host 侧档位表的源码路径（相对本包）。 */
const HOST_TIERS = fileURLToPath(new URL('../../../host/model-gateway/src/tiers.ts', import.meta.url))

/** host 源码文本；读不到就让下面每条测试都带上真实原因红掉。 */
function hostSource(): string {
  return readFileSync(HOST_TIERS, 'utf8')
}

/**
 * 从 host 源码里取某一档的一个数值字段。
 *
 * 只做"在 id 之后、下一个 id 之前的那一段里找 `字段: 数值`"这一件事：
 * 比整文件正则更抗改动（新增档位不会误伤），又不依赖 TypeScript 解析。
 * @param id - 档位 id。
 * @param field - 字段名。
 * @returns 数值；找不到返回 `null`（由断言报出来，而不是抛异常）。
 */
function hostNumber(id: string, field: string): number | null {
  const source = hostSource()
  const start = source.indexOf(`id: '${id}'`)
  if (start < 0) return null
  // 到下一个档位（或文件末）为止，就是本档的字段区。
  const nextIds = ['basic', 'plus', 'max'].map(other => source.indexOf(`id: '${other}'`, start + 1)).filter(at => at > 0)
  const end = nextIds.length > 0 ? Math.min(...nextIds) : source.length
  const segment = source.slice(start, end)
  const match = new RegExp(`\\b${field}:\\s*([0-9_]+)`, 'u').exec(segment)
  if (match === null) return null
  return Number(match[1]?.replace(/_/g, ''))
}

describe('契约：客户端档位商品表与服务端 TIERS 一致', () => {
  it('host 的 tiers 源码可读（路径变了这条会红，那就是要的通知）', () => {
    expect(hostSource()).toContain('SP_PER_YUAN')
  })

  it('三档 id 与服务端一一对应', () => {
    for (const offer of TIER_OFFERS) {
      expect(hostNumber(offer.id, 'monthlyYuan'), `${offer.id} 的 id 在 host 侧不存在`).not.toBeNull()
    }
  })

  it('每档的月费、每月 SP、上下文、并发都与服务端逐字段相同', () => {
    for (const offer of TIER_OFFERS) {
      expect(hostNumber(offer.id, 'monthlyYuan'), `${offer.id}.monthlyYuan`).toBe(offer.monthlyYuan)
      expect(hostNumber(offer.id, 'monthlySp'), `${offer.id}.monthlySp`).toBe(offer.monthlySp)
      expect(hostNumber(offer.id, 'contextLimitTokens'), `${offer.id}.contextLimitTokens`).toBe(offer.contextLimitTokens)
      expect(hostNumber(offer.id, 'concurrency'), `${offer.id}.concurrency`).toBe(offer.concurrency)
    }
  })

  it('SP 锚定 1 SP = 0.01 元：服务端 SP_PER_YUAN 必须是 100', () => {
    const source = hostSource()
    const match = /SP_PER_YUAN\s*=\s*([0-9_]+)/u.exec(source)
    expect(match, 'host 侧没有 SP_PER_YUAN').not.toBeNull()
    expect(Number(match?.[1]?.replace(/_/g, ''))).toBe(100)
  })

  it('三档的每元 SP **相同**，差别在绝对额度与上限', () => {
    // 这条断言我一开始写反了：我原以为"越高档每元越划算"，写成了严格递增，
    // 结果是测试把我拦下来（39/390、99/990、299/2990 都是 10 SP/元）。
    // 保留这个教训：界面上**不能**说"升级更省钱"——那是假的；
    // 真实的差别是绝对额度更大、并发更高、上下文更长、能用强力模型。
    const rates = TIER_OFFERS.map(offer => spPerYuan(offer))
    for (const [index, rate] of rates.entries()) {
      expect(rate, `第 ${index + 1} 档算不出每元 SP`).not.toBeNull()
    }
    expect(rates[0]).toBe(10)
    expect(rates[1]).toBe(rates[0])
    expect(rates[2]).toBe(rates[0])
  })

  it('三档的绝对额度与并发严格递增（这才是真实的差别）', () => {
    for (let index = 1; index < TIER_OFFERS.length; index += 1) {
      expect(TIER_OFFERS[index]!.monthlySp).toBeGreaterThan(TIER_OFFERS[index - 1]!.monthlySp)
      expect(TIER_OFFERS[index]!.concurrency).toBeGreaterThan(TIER_OFFERS[index - 1]!.concurrency)
      expect(TIER_OFFERS[index]!.contextLimitTokens).toBeGreaterThan(TIER_OFFERS[index - 1]!.contextLimitTokens)
    }
  })

  it('未知档位返回 null，不硬塞进三档模型', () => {
    expect(offerOf('enterprise-2099')).toBeNull()
  })
})
