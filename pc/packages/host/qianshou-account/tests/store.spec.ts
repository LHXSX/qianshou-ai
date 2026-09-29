import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { accountStore, ACCOUNT_ACCESS_REF } from '../src/store.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(MemoryCredentials, { OTHER_API_KEY: 'other-fixture', QIANSHOU_ACCESS_TOKEN: 'legacy-fixture' })
  return { ctx, store: accountStore(ctx.credentials) }
}

describe('account credential ownership', () => {
  it('persists only its managed reference and grant without replacing existing keys', async () => {
    const { ctx, store } = await fixture()
    expect(await store.readRefresh()).toBeNull()
    await store.write('refresh-fixture', 'access-fixture')
    expect(await store.readRefresh()).toBe('refresh-fixture')
    expect((await ctx.credentials.resolve(credentialRef(ACCOUNT_ACCESS_REF)))?.value).toBe('access-fixture')
    await store.clear()
    expect(await store.readRefresh()).toBeNull()
    expect(await ctx.credentials.resolve(credentialRef(ACCOUNT_ACCESS_REF))).toBeUndefined()
    expect((await ctx.credentials.resolve(credentialRef('OTHER_API_KEY')))?.value).toBe('other-fixture')
    expect((await ctx.credentials.resolve(credentialRef('QIANSHOU_ACCESS_TOKEN')))?.value).toBe('legacy-fixture')
  })
  it('deletes its refresh grant even when an environment override makes the reference read-only', async () => {
    const { ctx, store } = await fixture()
    await store.write('refresh-fixture', 'access-fixture')
    vi.spyOn(ctx.credentials, 'describe').mockResolvedValue({ configured: true, writable: false, source: 'environment' })
    const unset = vi.spyOn(ctx.credentials, 'unset')
    await expect(store.clear()).rejects.toThrow('storage-failed')
    expect(await store.readRefresh()).toBeNull()
    expect(await ctx.credentials.readRecord(credentialKey('qianshou-account', 'session'))).toBeUndefined()
    expect(unset).not.toHaveBeenCalled()
  })
  it('refuses a malformed durable grant without disclosing the payload', async () => {
    const { ctx, store } = await fixture()
    await ctx.credentials.modifyRecord(credentialKey('qianshou-account', 'session'), async () => ({ kind: 'grant', payload: { version: 99, refresh: 'private-value' } }))
    await expect(store.readRefresh()).rejects.toThrow('storage-failed')
  })
})
