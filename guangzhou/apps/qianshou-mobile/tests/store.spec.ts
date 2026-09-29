/**
 * 手机端本地存储的契约测试。
 *
 * 这些断言锁的是"数据边界"而不是实现细节：密钥与会话各存各的、损坏数据不能
 * 让应用崩掉、会话有上限。手机浏览器配额写满后整个应用写不动，是这类应用
 * 最常见的现实故障，所以上限必须被测试钉住。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_SESSIONS, StorageUnavailable, defaultSettings, loadSecret, loadSessions, loadSettings,
  newSessionId, saveSecret, saveSessions, saveSettings, titleFrom,
} from '../src/store.ts'
import type { StoredSession } from '../src/store.ts'

/** 一个最小可用的 localStorage 替身；只实现被用到的三个方法。 */
function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const map = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  })
  return map
}

afterEach(() => { vi.unstubAllGlobals() })

describe('连接设置', () => {
  it('从未配置过时给出 DeepSeek 默认值，且不含密钥', () => {
    installStorage()
    const settings = loadSettings()
    expect(settings.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(settings.model).toBe('deepseek-chat')
    expect(JSON.stringify(settings)).not.toMatch(/sk-|key|secret/i)
  })

  it('保存后能原样读回', () => {
    installStorage()
    saveSettings({ providerId: 'custom', baseUrl: 'https://my.gateway/v1', model: 'my-model' })
    const settings = loadSettings()
    expect(settings.baseUrl).toBe('https://my.gateway/v1')
    expect(settings.model).toBe('my-model')
    expect(settings.providerId).toBe('custom')
  })

  it('存储里的字段缺失时逐项回退到默认值，不用整体替换', () => {
    installStorage({ 'qianshou.mobile.connection.v1': JSON.stringify({ model: 'only-model' }) })
    const settings = loadSettings()
    expect(settings.model).toBe('only-model')
    expect(settings.baseUrl).toBe('https://api.deepseek.com/v1')
  })

  it('存储内容损坏时不崩溃，回退到默认值', () => {
    installStorage({ 'qianshou.mobile.connection.v1': '{ 这不是 JSON' })
    expect(loadSettings().model).toBe('deepseek-chat')
  })
})

describe('密钥', () => {
  it('未设置时是空串', () => {
    installStorage()
    expect(loadSecret()).toBe('')
  })

  it('设置后能读回，且与连接设置分开存放', () => {
    const map = installStorage()
    saveSecret('sk-example')
    saveSettings({ providerId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' })
    expect(loadSecret()).toBe('sk-example')
    // 连接设置那份里绝不能出现密钥
    expect(map.get('qianshou.mobile.connection.v1')).not.toContain('sk-example')
  })

  it('传空串表示清除', () => {
    installStorage()
    saveSecret('sk-example')
    saveSecret('')
    expect(loadSecret()).toBe('')
  })

  it('存储坏了时返回空串而不是抛异常', () => {
    installStorage({ 'qianshou.mobile.secret.v1': 'not json' })
    expect(loadSecret()).toBe('')
  })
})

describe('会话', () => {
  const session = (id: string, updatedAt: number): StoredSession => ({
    id, title: `t-${id}`, updatedAt, messages: [{ role: 'user', content: 'hi' }],
  })

  it('按最近更新倒序读出', () => {
    installStorage()
    saveSessions([session('a', 1), session('b', 3), session('c', 2)])
    expect(loadSessions().map(s => s.id)).toEqual(['b', 'c', 'a'])
  })

  it('超过上限时丢弃最旧的', () => {
    installStorage()
    const many = Array.from({ length: MAX_SESSIONS + 5 }, (_, i) => session(`s${i}`, i))
    saveSessions(many)
    const kept = loadSessions()
    expect(kept).toHaveLength(MAX_SESSIONS)
    expect(kept[0]?.id).toBe(`s${MAX_SESSIONS + 4}`)
  })

  it('损坏的条目被过滤掉，不影响其余会话', () => {
    installStorage({ 'qianshou.mobile.sessions.v1': JSON.stringify([{ id: 'ok', title: 't', updatedAt: 1, messages: [] }, { 乱码: true }, null]) })
    const kept = loadSessions()
    expect(kept).toHaveLength(1)
    expect(kept[0]?.id).toBe('ok')
  })

  it('存满配额时抛出可识别的错误，而不是静默丢数据', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError') },
      removeItem: () => {},
    })
    expect(() => saveSessions([session('a', 1)])).toThrow(StorageUnavailable)
  })
})

describe('标题与会话 id', () => {
  it('标题取首条用户消息的第一行并截断', () => {
    expect(titleFrom([{ role: 'user', content: '\n  帮我分析市场机会\n第二行' }])).toBe('帮我分析市场机会')
    expect(titleFrom([{ role: 'user', content: 'x'.repeat(100) }])).toHaveLength(24)
  })

  it('没有用户消息时给出中性标题', () => {
    expect(titleFrom([{ role: 'system', content: 'x' }])).toBe('新对话')
  })

  it('生成的会话 id 互不相同', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId()))
    expect(ids.size).toBe(50)
  })

  it('默认设置与常量导出保持一致', () => {
    expect(defaultSettings().providerId).toBe('deepseek')
    expect(MAX_SESSIONS).toBeGreaterThan(0)
  })
})
