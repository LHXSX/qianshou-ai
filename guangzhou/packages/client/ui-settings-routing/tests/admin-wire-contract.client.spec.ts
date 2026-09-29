/**
 * 契约测试：用**真实 admin 处理器吐出的响应**检验控制台的解析器。
 *
 * 为什么需要它：我给控制台子智能体的简报里写的是"顶层有 `bindings`"，
 * 而实现把历史挂在 `names[].history` 上——**简报是错的**。子智能体按实际代码
 * 做了两种形状的兼容，但"按某人的描述实现"和"对着真实响应验证"是两件事。
 * 这份夹具由 `capture-wire.mjs` 从真实处理器抓取，这里就是把真实响应用真实解析器吃一遍。
 *
 * 若宿主改了响应形状，抓取脚本会产出新夹具，这份测试就会红。
 * 刷新：`PATH=/opt/homebrew/bin:$PATH node node_modules/tsx/dist/cli.mjs packages/host/model-gateway/tools/capture-wire.mjs --write`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADMIN_NAMES_PATH, parseRouteCatalog } from '../src/client/route-catalog.ts'

/** 真实响应的外层。 */
interface AdminWire {
  readonly note: string
  readonly namesPath: string
  readonly names: unknown
}

const wire = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'admin-names-wire.json'), 'utf8'),
) as AdminWire

describe('契约：控制台解析器对真实 admin 响应', () => {
  it('夹具确实是抓来的，且路径与常量一致', () => {
    expect(wire.note).toContain('capture-wire.mjs')
    // 路径写错就等于面板永远打不开，而现象只是"没数据"。
    expect(wire.namesPath).toBe(ADMIN_NAMES_PATH)
  })

  it('真实响应能被解析（历史挂在 names[].history 而不是顶层 bindings）', () => {
    // `parseRouteCatalog` 形状不对就抛，所以"不抛"本身就是断言。
    const parsed = parseRouteCatalog(wire.names)
    expect(parsed.names.length).toBeGreaterThan(0)
    // 每个名字都要带出自己的历史；空历史也要是空数组而不是 undefined。
    for (const name of parsed.names) expect(Array.isArray(name.history)).toBe(true)
  })

  it('后端键位被解析出来，且上游标识被放进独立的内部字段', () => {
    const parsed = parseRouteCatalog(wire.names)
    const keys = parsed.backends.map(backend => backend.key)
    expect(keys).toContain('flash')
    for (const backend of parsed.backends) {
      // `upstreamId` 是内部字段：解析器收下它，但界面只渲染 key 与并发。
      // 这里断言它确实被收在独立字段里，避免有人图省事把它塞进 key。
      expect(backend.upstreamId).not.toBe(backend.key)
      expect(backend.key).not.toMatch(/deepseek/i)
    }
  })

  it('绑定记录的关键字段齐全（生效时刻、后端顺序、灰度）', () => {
    const parsed = parseRouteCatalog(wire.names)
    const bindings = parsed.names.flatMap(name => name.history)
    expect(bindings.length).toBeGreaterThan(0)
    for (const binding of bindings) {
      expect(Number.isFinite(binding.effectiveFrom)).toBe(true)
      expect(binding.backendKeys.length).toBeGreaterThan(0)
      expect(binding.rolloutPercent).toBeGreaterThanOrEqual(0)
      expect(binding.rolloutPercent).toBeLessThanOrEqual(100)
    }
  })

  it('形状被破坏时整体拒绝，而不是静默丢字段', () => {
    // 少一个字段就整体拒绝：**部分解析出来的目录会让人按错的信息去改线上绑定**，
    // 而绑定只追加、改不回来——所以宁可整体报"数据不完整"。
    expect(() => parseRouteCatalog({ ok: true, names: [] })).toThrow()
    expect(() => parseRouteCatalog(null)).toThrow()
    expect(() => parseRouteCatalog({ ...(wire.names as object), backends: undefined })).toThrow()
  })
})
