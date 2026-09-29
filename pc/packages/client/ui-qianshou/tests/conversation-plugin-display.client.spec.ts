import { expect, it } from 'vitest'
import { conversationPluginDisplayTitle } from '../src/client/conversation-plugin-display.ts'
import { pluginBorrowDraft } from '../src/client/conversation-plugin-borrow.ts'

const generated = 'qianshou-local-372c8f492ed345b6ad39cadc785a9410'

it.each([
  ['字符统计插件：统计中文与 emoji。', '字符统计插件'],
  ['文档清理助手。处理多段文本。', '文档清理助手'],
  ['Word Counter: Counts Unicode characters.', 'Word Counter'],
  ['', '本机插件'],
  ['  ：后续说明不充当名称', '本机插件'],
])('shows the public heading for a generated package: %s', (description, expected) => {
  expect(conversationPluginDisplayTitle(generated, description, '本机插件')).toBe(expected)
})

it.each(['中文人工名称', 'My local plugin', 'qianshou-local-custom', 'qianshou-local-abcd'])(
  'preserves a manually named or non-generated title: %s', (title) => {
    expect(conversationPluginDisplayTitle(title, '另一段说明：不替换原名', '本机插件')).toBe(title)
  },
)

it('bounds a generated heading without splitting emoji graphemes', () => {
  expect(conversationPluginDisplayTitle(generated, '👨‍👩‍👧‍👦'.repeat(40), '本机插件')).toBe('👨‍👩‍👧‍👦'.repeat(36) + '…')
})

it('keeps the original installed identity in the borrowing draft after deriving a display title', () => {
  const plugin = { id: 'bundle:generated-local', title: generated, description: '字符统计插件：统计中文。' }
  expect(conversationPluginDisplayTitle(plugin.title, plugin.description, '本机插件')).toBe('字符统计插件')
  const draft = pluginBorrowDraft(plugin, '统计这段中文')
  expect(draft).toContain('候选插件名称："' + generated + '"')
  expect(draft).toContain('本机清单标识："bundle:generated-local"')
  expect(draft).toContain('我的任务：统计这段中文')
})
