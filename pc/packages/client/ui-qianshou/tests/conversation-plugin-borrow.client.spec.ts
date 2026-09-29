import { describe, expect, it } from 'vitest'
import { activeConversationPlugins, pluginBorrowDraft } from '../src/client/conversation-plugin-borrow.ts'
import type { IntakeOrderSource } from '../src/client/node-status/supply-transport.ts'

function source(id: string, kind: IntakeOrderSource['kind'], loadState: IntakeOrderSource['loadState']): IntakeOrderSource {
  return { id, kind, source: 'profile-bundle', title: id, description: '本机插件', category: null,
    loadState, capabilityId: null, taskType: null, serviceId: null, selectable: false,
    eligible: false, enabled: false, reason: 'platform-task-unmapped' }
}

describe('conversation plugin borrowing', () => {
  it('lists active plugins from any installed source, not skills or disabled packages', () => {
    expect(activeConversationPlugins([
      source('bundle:active', 'plugin', 'active'), source('entry:active', 'plugin', 'active'),
      source('bundle:off', 'plugin', 'disabled'), source('skill:directions', 'skill', 'active'),
    ])).toEqual([
      { id: 'bundle:active', title: 'bundle:active', description: '本机插件' },
      { id: 'entry:active', title: 'entry:active', description: '本机插件' },
    ])
  })

  it('preserves the user task and requires a verifiable plugin tool result', () => {
    const prompt = pluginBorrowDraft({ id: 'bundle:a', title: '词频插件', description: '' }, '请统计这段话')
    expect(prompt).toContain('候选插件名称："词频插件"')
    expect(prompt).toContain('实际工具名、调用是否成功和结果')
    expect(prompt).toContain('我的任务：请统计这段话')
    expect(pluginBorrowDraft({ id: 'bundle:a', title: '词频插件', description: '' }, prompt)).toBe(prompt)
  })
})
