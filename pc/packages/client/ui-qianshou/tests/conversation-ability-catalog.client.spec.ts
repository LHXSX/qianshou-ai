import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { MarketCapability } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionInputShell } from '../../ui-conversation/src/client/input/facade.ts'
import { canSelectConversationAbility, conversationAbilityDraft, listConversationAbilities } from '../src/client/conversation-ability-catalog.ts'
import { pluginBorrowDraft } from '../src/client/conversation-plugin-borrow.ts'
import { abilitySubdivision } from '../src/client/ability-taxonomy.ts'

const ability: MarketCapability = { taskType: 'word_count', capabilityId: 'text', name: '词频统计', description: '统计词频',
  category: 'text', categoryLabelZh: '文字', acceptedInputKinds: ['inline'], defaultInputKind: 'inline', requiredParams: [],
  outputKind: 'json', contractVersion: '1', publisherKind: 'official', publisherKinds: ['official'], executionMode: 'cloud',
  availability: 'contract_ready', requiresQuote: true, executionQuotePath: '/api/v8/developer/tasks/estimate', currency: 'CNY', products: [] }

describe('conversation ability selection', () => {
  it('reads the existing catalog and propagates catalog failure without quoting or executing', async () => {
    const remote = { orderAdapterCapabilities: vi.fn(async () => ({ ok: true as const, value: { capabilities: [ability] } })) }
    expect(await listConversationAbilities(remote)).toEqual([ability])
    expect(remote.orderAdapterCapabilities).toHaveBeenCalledOnce()
    await expect(listConversationAbilities({ orderAdapterCapabilities: async () => ({ ok: false, error: { message: 'offline' } }) }))
      .rejects.toThrow('offline')
  })

  it('requires an inline or multi-file dispatch contract and rejects identical and whitespace-prefixed names', () => {
    expect(canSelectConversationAbility(ability, [ability])).toBe(true)
    const files = { ...ability, acceptedInputKinds: ['multi_file'], defaultInputKind: 'multi_file' }
    expect(canSelectConversationAbility(files, [files])).toBe(true)
    for (const override of [{ availability: 'paused' }, { formReady: false }, { acceptedInputKinds: ['file'] },
      { acceptedInputKinds: ['single_file'] }, { executionQuotePath: null }] satisfies Partial<MarketCapability>[]) {
      expect(canSelectConversationAbility({ ...ability, ...override }, [ability])).toBe(false)
    }
    expect(canSelectConversationAbility(ability, [ability, { ...ability, taskType: 'copy' }])).toBe(false)
    const longer = { ...ability, taskType: 'long', name: `${ability.name} 高精度` }
    expect(canSelectConversationAbility(ability, [ability, longer])).toBe(false)
    expect(canSelectConversationAbility(longer, [ability, longer])).toBe(false)
    const distinct = { ...ability, taskType: 'distinct', name: `${ability.name}高精度` }
    expect(canSelectConversationAbility(distinct, [ability, distinct])).toBe(true)
  })

  it('preserves exact drafts and canonical reference text through the real composer shell', () => {
    const shell = new SessionInputShell({ actx: {} as Context, defaultSink: vi.fn(),
      commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: token => token } })
    const draft = '  \t任务\n\n@[资料](dsh-session:InNvdXJjZSI)  '
    for (const reference of ['/local-skill', '@词频统计']) {
      shell.setDraft(draft)
      const next = conversationAbilityDraft(reference, shell.snapshot.draft)
      shell.setDraft(next)
      expect(shell.snapshot.draft).toBe(`${reference} ${draft}`)
      expect(conversationAbilityDraft(reference, shell.snapshot.draft)).toBe(shell.snapshot.draft)
    }
    shell.setDraft(draft)
    shell.setDraft(pluginBorrowDraft({ id: 'local:plugin', title: '词频插件', description: '' }, shell.snapshot.draft))
    expect(shell.snapshot.draft.endsWith(`我的任务：${draft}`)).toBe(true)
    shell.dispose()
  })

  it('uses verified descriptions for subdivisions and keeps unfamiliar abilities in Other', () => {
    expect(abilitySubdivision('text', 'custom', '统计字符')).toEqual({ id: 'statistics', key: 'abilitySubTextStatistics' })
    expect(abilitySubdivision('image', 'custom', '识别图片文字')).toEqual({ id: 'recognition', key: 'abilitySubImageRecognition' })
    expect(abilitySubdivision('data', 'custom', '清洗数据')).toEqual({ id: 'processing', key: 'abilitySubDataProcessing' })
    expect(abilitySubdivision('ppt', 'custom', '设计模板')).toEqual({ id: 'design', key: 'abilitySubPptDesign' })
    expect(abilitySubdivision('text', 'custom', '独有的能力')).toEqual({ id: 'other', key: 'skillCategoryOther' })
  })
})
