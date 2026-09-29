/**
 * 审计、两步确认、会话的测试。
 *
 * 三样东西共同的失效模式都是"看起来记了/确认了，实际上没有"：
 * 审计漏字段、令牌能被重放、会话过期后还能用。所以每条断言都盯着一个具体的坏结果。
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeDiff, createAuditLog, isSecretKey, redact } from '../src/audit.ts'
import { createConfirmStore, hashPayload } from '../src/confirm.ts'
import { createSessionStore, readSessionCookie, sessionCookie } from '../src/session.ts'

/** 临时目录。 */
async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'admin-console-audit-'))
}

describe('审计：遮盖与差异', () => {
  it('口令/令牌/cookie 一律被遮盖（审计文件是要被很多人读的）', () => {
    const redacted = redact({ username: 'admin', password: 'hunter2', nested: { access_token: 'abc', refreshToken: 'def', ok: 1 } }) as Record<string, unknown>
    expect(redacted['username']).toBe('admin')
    expect(redacted['password']).toBe('***')
    expect((redacted['nested'] as Record<string, unknown>)['access_token']).toBe('***')
    expect((redacted['nested'] as Record<string, unknown>)['refreshToken']).toBe('***')
    expect((redacted['nested'] as Record<string, unknown>)['ok']).toBe(1)
    expect(isSecretKey('old_password')).toBe(true)
    expect(isSecretKey('x-api-key')).toBe(true)
    expect(isSecretKey('username')).toBe(false)
  })

  it('差异逐字段给出 before → after（权限矩阵改了什么一眼可见）', () => {
    const diff = computeDiff(
      { id: 'ops', permissions: ['account.read'], scopeDefault: 'all' },
      { id: 'ops', permissions: ['account.read', 'order.refund'], scopeDefault: 'self' },
    )
    const paths = diff.map(row => row.path).sort()
    expect(paths).toEqual(['permissions', 'scopeDefault'])
    expect(diff.find(row => row.path === 'scopeDefault')).toEqual({ path: 'scopeDefault', before: 'all', after: 'self' })
  })

  it('没有差异时返回空数组（幂等写入不该伪造出一条变更）', () => {
    expect(computeDiff({ a: 1 }, { a: 1 })).toEqual([])
  })

  it('新增与删除给出 before=null / after=null', () => {
    const created = computeDiff(null, { id: 'x' })
    expect(created).toEqual([{ path: 'id', before: null, after: 'x' }])
  })
})

describe('审计：只追加、可查询、坏行不静默', () => {
  it('写入后可按动作前缀/结果/操作人过滤，并按时间倒序', async () => {
    const dir = await tempDir()
    let clock = 1000
    const log = createAuditLog({ path: join(dir, 'audit.jsonl'), now: () => clock, newId: () => `id-${clock}` })
    await log.record({ actorType: 'admin', actorId: '167', actorRole: 'ops', ip: '203.0.113.7', addressSource: 'x-real-ip', action: 'session.login', target: 'admin:167', result: 'allow', reason: '', summary: '登录成功' })
    clock = 2000
    await log.record({ actorType: 'admin', actorId: '167', actorRole: 'ops', ip: '203.0.113.7', addressSource: 'x-real-ip', action: 'access.denied', target: '/rbac/roles/apply', result: 'deny', reason: '缺少权限 rbac.manage', summary: '越权尝试' })
    clock = 3000
    await log.record({ actorType: 'admin', actorId: '200', actorRole: 'auditor', ip: '198.51.100.1', addressSource: 'x-real-ip', action: 'audit.list', target: '-', result: 'allow', reason: '', summary: '查审计' })

    const all = await log.query({})
    expect(all.total).toBe(3)
    expect(all.entries[0]?.actorId).toBe('200')

    const denied = await log.query({ result: 'deny' })
    expect(denied.total).toBe(1)
    expect(denied.entries[0]?.action).toBe('access.denied')

    const byPrefix = await log.query({ actionPrefix: 'session.' })
    expect(byPrefix.total).toBe(1)

    const byActor = await log.query({ actorId: '167' })
    expect(byActor.total).toBe(2)
  })

  it('数据范围 self 只看自己的记录（服务端裁剪）', async () => {
    const dir = await tempDir()
    const log = createAuditLog({ path: join(dir, 'audit.jsonl'), now: () => 1, newId: () => `id-${Math.random()}` })
    for (const actorId of ['167', '200', '167']) {
      await log.record({ actorType: 'admin', actorId, actorRole: 'ops', ip: '203.0.113.7', addressSource: 'x-real-ip', action: 'x', target: '-', result: 'allow', reason: '', summary: '' })
    }
    const scoped = await log.query({ scope: 'self', selfId: '167' })
    expect(scoped.total).toBe(2)
    expect(scoped.entries.every(entry => entry.actorId === '167')).toBe(true)
  })

  it('分页与总数分开（total 是过滤后的总数，不是本页条数）', async () => {
    const dir = await tempDir()
    const log = createAuditLog({ path: join(dir, 'audit.jsonl'), now: () => 1, newId: () => `id-${Math.random()}` })
    for (let index = 0; index < 5; index += 1) {
      await log.record({ actorType: 'admin', actorId: '167', actorRole: 'ops', ip: '1.1.1.1', addressSource: 'socket', action: 'x', target: '-', result: 'allow', reason: '', summary: '' })
    }
    const page = await log.query({ limit: 2, offset: 1 })
    expect(page.total).toBe(5)
    expect(page.entries).toHaveLength(2)
  })

  it('坏行被计数而不是被静默丢掉（审计有洞必须看得见）', async () => {
    const dir = await tempDir()
    const path = join(dir, 'audit.jsonl')
    const log = createAuditLog({ path, now: () => 1, newId: () => 'id-1' })
    await log.record({ actorType: 'admin', actorId: '167', actorRole: 'ops', ip: '1.1.1.1', addressSource: 'socket', action: 'x', target: '-', result: 'allow', reason: '', summary: '' })
    await writeFile(path, '{这不是 JSON\n', { flag: 'a' })
    const result = await log.query({})
    expect(result.total).toBe(1)
    expect(result.brokenLines).toBe(1)
  })

  it('按 id 取详情', async () => {
    const dir = await tempDir()
    const log = createAuditLog({ path: join(dir, 'audit.jsonl'), now: () => 1, newId: () => 'audit-1' })
    await log.record({ actorType: 'admin', actorId: '167', actorRole: 'ops', ip: '1.1.1.1', addressSource: 'socket', action: 'x', target: '-', result: 'allow', reason: '', summary: '' })
    expect((await log.detail('audit-1'))?.actorId).toBe('167')
    expect(await log.detail('不存在')).toBeNull()
  })

  it('落盘内容里没有明文口令', async () => {
    const dir = await tempDir()
    const path = join(dir, 'audit.jsonl')
    const log = createAuditLog({ path, now: () => 1, newId: () => 'audit-1' })
    await log.record({
      actorType: 'anonymous', actorId: '-', actorRole: '-', ip: '1.1.1.1', addressSource: 'socket',
      action: 'session.login', target: '-', result: 'deny', reason: 'invalid_credentials',
      summary: '登录失败', before: { password: 'hunter2' },
    })
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('hunter2')
    expect(text).toContain('***')
  })
})

describe('两步确认：令牌绑定载荷、一次性、会过期', () => {
  it('同一份载荷才能消费（换个目标就拒绝）', () => {
    const store = createConfirmStore({ newToken: () => 'token-1', now: () => 0 })
    store.issue({ actorId: '167', action: 'whitelist.entries', payload: { op: 'add', cidr: '203.0.113.0/24' } })
    expect(store.consume({ token: 'token-1', actorId: '167', action: 'whitelist.entries', payload: { op: 'add', cidr: '198.51.100.0/24' } }))
      .toEqual({ ok: false, code: 'confirm_mismatch' })
  })

  it('换人、换动作都不行', () => {
    const first = createConfirmStore({ newToken: () => 'token-1', now: () => 0 })
    first.issue({ actorId: '167', action: 'flags', payload: { key: 'x' } })
    expect(first.consume({ token: 'token-1', actorId: '200', action: 'flags', payload: { key: 'x' } }))
      .toEqual({ ok: false, code: 'confirm_mismatch' })

    const second = createConfirmStore({ newToken: () => 'token-2', now: () => 0 })
    second.issue({ actorId: '167', action: 'flags', payload: { key: 'x' } })
    expect(second.consume({ token: 'token-2', actorId: '167', action: 'whitelist.entries', payload: { key: 'x' } }))
      .toEqual({ ok: false, code: 'confirm_mismatch' })
  })

  it('一次性：用过就没了', () => {
    const store = createConfirmStore({ newToken: () => 'token-1', now: () => 0 })
    store.issue({ actorId: '167', action: 'flags', payload: { key: 'x' } })
    expect(store.consume({ token: 'token-1', actorId: '167', action: 'flags', payload: { key: 'x' } })).toEqual({ ok: true })
    expect(store.consume({ token: 'token-1', actorId: '167', action: 'flags', payload: { key: 'x' } })).toEqual({ ok: false, code: 'confirm_invalid' })
  })

  it('过期就作废', () => {
    let clock = 0
    const store = createConfirmStore({ newToken: () => 'token-1', now: () => clock, ttlMs: 1000 })
    store.issue({ actorId: '167', action: 'flags', payload: { key: 'x' } })
    clock = 1001
    expect(store.consume({ token: 'token-1', actorId: '167', action: 'flags', payload: { key: 'x' } })).toEqual({ ok: false, code: 'confirm_expired' })
  })

  it('载荷哈希与键顺序无关（否则用户重排字段就被拒）', () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }))
  })
})

describe('会话：内存、哈希存储、有效期', () => {
  const base = {
    accountId: '167',
    displayName: '张三',
    createdAt: 0,
    expiresAt: 10_000,
    ip: '203.0.113.7',
    tokens: null,
  }

  it('签发后可取回；令牌原文不落内存（按哈希存）', () => {
    const store = createSessionStore({ now: () => 0, newToken: () => 'raw-token', ttlMs: 100_000 })
    store.issue(base)
    expect(store.get('raw-token')?.accountId).toBe('167')
    expect(store.list()).toHaveLength(1)
    // 内存里的键是哈希，不是令牌原文。
    expect(JSON.stringify([...store.list()])).not.toContain('raw-token')
  })

  it('绝对有效期到期即失效并被删除', () => {
    let clock = 0
    const store = createSessionStore({ now: () => clock, newToken: () => 't', ttlMs: 1000 })
    store.issue({ ...base, expiresAt: 5000 })
    clock = 1500
    expect(store.get('t')).toBeNull()
    expect(store.size()).toBe(0)
  })

  it('空闲超时失效', () => {
    let clock = 0
    const store = createSessionStore({ now: () => clock, newToken: () => 't', ttlMs: 10_000_000, idleMs: 1000 })
    store.issue({ ...base, expiresAt: 10_000_000 })
    clock = 500
    store.touch('t')
    clock = 1400
    expect(store.get('t')).not.toBeNull()
    clock = 2500
    expect(store.get('t')).toBeNull()
  })

  it('吊销与按账号吊销（撤权后旧会话必须立刻失效）', () => {
    const store = createSessionStore({ now: () => 0, newToken: (() => { let n = 0; return () => `t${n += 1}` })(), ttlMs: 10_000 })
    store.issue(base)
    store.issue({ ...base, accountId: '200' })
    expect(store.revokeByAccount('167')).toBe(1)
    expect(store.get('t1')).toBeNull()
    expect(store.get('t2')).not.toBeNull()
    expect(store.revoke('t2')).toBe(true)
    expect(store.size()).toBe(0)
  })

  it('cookie 解析与属性', () => {
    const header = sessionCookie('abc', 3600)
    expect(header).toContain('qianshou_admin_sid=abc')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('Secure')
    expect(header).toContain('SameSite=Strict')
    expect(readSessionCookie('a=1; qianshou_admin_sid=abc; b=2')).toBe('abc')
    expect(readSessionCookie('a=1')).toBeNull()
    expect(readSessionCookie(undefined)).toBeNull()
  })
})
