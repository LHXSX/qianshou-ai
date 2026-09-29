/**
 * 版本检查的契约测试。
 *
 * 重点不是「能不能发现新版本」，而是**三条不能错的行为**：不自动刷新、检查失败不冒错、
 * 冷启动只记基线不提示。这三条任何一条错了都会变成用户侧的骚扰，而不是报错。
 */
import { describe, expect, it, vi } from 'vitest'
import { bundleOf, watchVersion } from '../src/version-watch.ts'

const OLD_HTML = '<html><body><script type="module" crossorigin src="/assets/index-OLD.js"></script></body></html>'
const NEW_HTML = '<html><body><script type="module" crossorigin src="/assets/index-NEW.js"></script></body></html>'

describe('从入口 HTML 里取版本', () => {
  it('认 module 入口脚本', () => {
    expect(bundleOf(OLD_HTML)).toBe('/assets/index-OLD.js')
  })

  it('没有 module 时退而取任意脚本', () => {
    expect(bundleOf('<script src="/a/b.js"></script>')).toBe('/a/b.js')
  })

  it('取不到时返回 null，而不是编一个', () => {
    expect(bundleOf('<html></html>')).toBeNull()
    expect(bundleOf('')).toBeNull()
  })
})

describe('监测线上版本', () => {
  /** 一个可控的「线上 HTML」。 */
  function harness(pages: string[]) {
    let index = 0
    const fetchHtml = vi.fn(async () => pages[Math.min(index, pages.length - 1)] ?? '')
    const advance = (): void => { index += 1 }
    return { fetchHtml, advance }
  }

  it('第一次检查只记基线，**不**提示（刚打开就说有新版本很奇怪）', async () => {
    const { fetchHtml } = harness([OLD_HTML])
    const onUpdate = vi.fn()
    const watch = watchVersion({ url: 'https://app.test/', fetchHtml, setInterval: () => 0, clearInterval: () => {} }, onUpdate)
    expect(await watch.check()).toBe(false)
    expect(onUpdate).not.toHaveBeenCalled()
    watch.stop()
  })

  it('入口变了才提示，并且只提示一次', async () => {
    const { fetchHtml, advance } = harness([OLD_HTML, NEW_HTML, NEW_HTML])
    const onUpdate = vi.fn()
    const watch = watchVersion({ url: 'https://app.test/', fetchHtml, setInterval: () => 0, clearInterval: () => {} }, onUpdate)
    await watch.check()
    advance()
    expect(await watch.check()).toBe(true)
    expect(onUpdate).toHaveBeenCalledTimes(1)
    // 再查一次也不重复打扰
    expect(await watch.check()).toBe(false)
    expect(onUpdate).toHaveBeenCalledTimes(1)
    watch.stop()
  })

  it('**不自动刷新**：回调只被调用，页面不会被重新加载', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { href: 'https://app.test/', reload })
    const onUpdate = vi.fn()
    const { fetchHtml, advance } = harness([OLD_HTML, NEW_HTML])
    const watch = watchVersion({ fetchHtml, setInterval: () => 0, clearInterval: () => {} }, onUpdate)
    await watch.check()
    advance()
    await watch.check()
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
    watch.stop()
    vi.unstubAllGlobals()
  })

  it('检查失败什么都不做：不提示、不抛、不改变基线', async () => {
    let fail = false
    const fetchHtml = vi.fn(async () => {
      if (fail) throw new Error('网络断了')
      return OLD_HTML
    })
    const onUpdate = vi.fn()
    const watch = watchVersion({ url: 'https://app.test/', fetchHtml, setInterval: () => 0, clearInterval: () => {} }, onUpdate)
    await watch.check()
    fail = true
    expect(await watch.check()).toBe(false)
    expect(onUpdate).not.toHaveBeenCalled()
    // 恢复后仍以原来的基线判断
    fail = false
    expect(await watch.check()).toBe(false)
    watch.stop()
  })

  it('停止之后不再检查', async () => {
    const { fetchHtml, advance } = harness([OLD_HTML, NEW_HTML])
    const onUpdate = vi.fn()
    const watch = watchVersion({ url: 'https://app.test/', fetchHtml, setInterval: () => 0, clearInterval: () => {} }, onUpdate)
    watch.stop()
    advance()
    expect(await watch.check()).toBe(false)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('按间隔轮询：定时器被装上，stop 时被摘掉', () => {
    const setInterval = vi.fn(() => 42)
    const clearInterval = vi.fn()
    const watch = watchVersion(
      { url: 'https://app.test/', intervalMs: 1234, fetchHtml: async () => OLD_HTML, setInterval, clearInterval },
      () => {},
    )
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 1234)
    watch.stop()
    expect(clearInterval).toHaveBeenCalledWith(42)
  })
})
