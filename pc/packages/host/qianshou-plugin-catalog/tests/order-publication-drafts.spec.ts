import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import QianshouPluginCatalog, { type Config } from '../src/index.ts'
import { orderPublicationDraftPath } from '../src/order-publication-drafts.ts'

const draftId = 'plugin_draft_12345678-1234-1234-1234-123456789abc'
const packageDigest = 'b'.repeat(64)
const candidate = { draftId, packageDigest, packageName: 'qianshou-local-test', packagePath: '/private/candidate',
  toolName: 'qianshou_local_test', sourceDigest: 'a'.repeat(64), displayName: '文字统计',
  description: '统计词频', operationTitle: '统计文字', preparedAt: 1,
  installableLocally: true as const, published: false as const, dispatchable: false as const,
  orderAdapter: { version: 1 as const, capabilityId: 'text.transform' as const, taskType: 'word_count' as const,
    inputKind: 'inline' as const, outputKind: 'inline_json' as const, contractVersion: 'v1' as const } }

function setup(home: string, candidates = [candidate]) {
  const ctx = new Context()
  ctx.provide('computeCore', { listLocalPluginCandidates: async () => candidates })
  const config: Config = { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
    connection: 'shipped', apiBaseUrl: '', installHome: home, publisherKeys: {} }
  return { ctx, config }
}

it('saves bounded author metadata locally and reloads it without publishing or granting orders', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-order-draft-'))
  const input = { draftId, packageDigest, name: '词频助手', purpose: '把文本汇总为词频结果',
    category: 'text' as const, configuration: '输入一段文字，不需要密钥。', salePriceYuan: '2.50' }
  try {
    const first = setup(home)
    await first.ctx.plugin(QianshouPluginCatalog, first.config)
    const saved = await first.ctx.qianshouPluginCatalog.saveLocalOrderPublicationDraft(input)
    expect(saved).toMatchObject({ ...input, state: 'local-draft', taskContract: candidate.orderAdapter })
    expect((await stat(orderPublicationDraftPath(home))).mode & 0o777).toBe(0o600)
    const path = orderPublicationDraftPath(home)
    const stored = JSON.parse(await readFile(path, 'utf8')) as {
      version: number; drafts: Array<Record<string, unknown>> }
    expect(stored).toMatchObject({ version: 1 })
    stored.drafts[0]!.salePriceEdg = stored.drafts[0]!.salePriceYuan
    delete stored.drafts[0]!.salePriceYuan
    await writeFile(path, JSON.stringify(stored) + '\n')
    await first.ctx.fiber.dispose()

    const second = setup(home)
    await second.ctx.plugin(QianshouPluginCatalog, second.config)
    expect(await second.ctx.qianshouPluginCatalog.localOrderPublicationDraft({ draftId, packageDigest }))
      .toEqual(saved)
    await expect(second.ctx.qianshouPluginCatalog.saveLocalOrderPublicationDraft({
      ...input, packageDigest: 'c'.repeat(64) })).rejects.toThrow()
    await expect(second.ctx.qianshouPluginCatalog.saveLocalOrderPublicationDraft({
      ...input, salePriceYuan: '0' })).rejects.toThrow()
    await second.ctx.fiber.dispose()

    const third = setup(home, [])
    await third.ctx.plugin(QianshouPluginCatalog, third.config)
    await expect(third.ctx.qianshouPluginCatalog.localOrderPublicationDraft({ draftId, packageDigest })).rejects.toThrow()
    await third.ctx.fiber.dispose()
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('fails closed on a malformed local draft file instead of replacing it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-order-draft-bad-'))
  const instance = setup(home)
  try {
    await instance.ctx.plugin(QianshouPluginCatalog, instance.config)
    const path = orderPublicationDraftPath(home)
    await instance.ctx.qianshouPluginCatalog.saveLocalOrderPublicationDraft({ draftId, packageDigest,
      name: '词频助手', purpose: '统计词频', category: 'text', configuration: '', salePriceYuan: null })
    await writeFile(path, '{broken', 'utf8')
    await expect(instance.ctx.qianshouPluginCatalog.localOrderPublicationDraft({ draftId, packageDigest })).rejects.toThrow()
    await expect(instance.ctx.qianshouPluginCatalog.saveLocalOrderPublicationDraft({ draftId, packageDigest,
      name: '另一个', purpose: '统计词频', category: 'data', configuration: '', salePriceYuan: null })).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('{broken')
  } finally { await instance.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
