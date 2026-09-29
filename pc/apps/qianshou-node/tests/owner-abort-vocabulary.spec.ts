/**
 * E3 词表的"不许分裂"闸。
 *
 * 背景（实测）：E3 在 `compute-core` 的实现**已不在源码树**——`src/edge-worker/owner-abort.ts` 与
 * `connection.ts` 里的 `abortByOwner` 都不存在，只剩 `lib/types/edge-worker/owner-abort.d.ts`
 * 这份构建产物（见 `owner-abort.ts` 头部注释）。E9 因此在本仓按结构声明了同一套词表。
 *
 * 两条断言，方向相反但都必要：
 * 1. **对遗留产物**：本仓常量必须与 E3 实际发射的常量**逐字相同**（词表不许漂移）。
 * 2. **对源码树**：如果 `compute-core` 将来**又出现** `owner-abort` 源码，它的常量也必须与
 *    本仓**逐字相同**——不一致就是两套说法，必须在那一刻红掉并合成一处。
 *    这一条刻意不在"源码存在"本身变红（那会把别的工作包的正常合入判成失败），只在**分裂**时红。
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OWNER_CANCEL_CODE, OWNER_CANCEL_STATE, OWNER_LOCAL_SOURCE } from '../owner-abort.ts'

const artifact = fileURLToPath(new URL('../../../packages/host/compute-core/lib/types/edge-worker/owner-abort.d.ts', import.meta.url))
const source = fileURLToPath(new URL('../../../packages/host/compute-core/src/edge-worker/owner-abort.ts', import.meta.url))

/** 从一段源码里取一个字面量常量的值；取不到返回 undefined（而不是拿默认值糊过去）。 */
function literal(code: string, name: string): string | undefined {
  return new RegExp(`${name}\\s*=\\s*['"]([^'"]+)['"]`, 'u').exec(code)?.[1]
}

describe('E9 · E3 中止词表不许长出第二套说法', () => {
  it('本仓常量就是 E3 的取值', () => {
    expect(OWNER_CANCEL_CODE).toBe('EDGE_CANCELED_BY_OWNER')
    expect(OWNER_CANCEL_STATE).toBe('canceled-by-owner')
    expect(OWNER_LOCAL_SOURCE).toBe('owner-local')
  })

  it.skipIf(!existsSync(artifact))('与 E3 的构建产物逐字一致', () => {
    const text = readFileSync(artifact, 'utf8')
    expect(text).toContain(`OWNER_CANCEL_CODE = "${OWNER_CANCEL_CODE}"`)
    expect(text).toContain(`OWNER_CANCEL_STATE = "${OWNER_CANCEL_STATE}"`)
  })

  it.runIf(existsSync(source))('若 compute-core 又有 owner-abort 源码，两处取值必须一致（否则红）', () => {
    const text = readFileSync(source, 'utf8')
    expect(literal(text, 'OWNER_CANCEL_CODE')).toBe(OWNER_CANCEL_CODE)
    expect(literal(text, 'OWNER_CANCEL_STATE')).toBe(OWNER_CANCEL_STATE)
  })
})
