/** Qianshou process rows exclude errors and tool cards with unknown interaction semantics. */
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { hasAssistantReplyContent } from '../contract/assistant-content.ts'

const ORDINARY_TOOLS = new Set([
  'bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'skill', 'web_search', 'web_fetch',
  'load_workspace_dependencies',
])

function ordinaryTool(block: ToolCallBlock): boolean {
  const name = 'kind' in block ? block.call?.name : block.name
  if (name === undefined || !ORDINARY_TOOLS.has(name)) return false
  if ('kind' in block) {
    if (block.isError || block.error !== undefined) return false
    if (block.content.some(content => content.type === 'text'
      && /\[exit code:\s*-?[1-9]\d*\]/.test(content.text))) return false
  }
  const raw = 'kind' in block ? block.call?.argsRaw : block.argsRaw
  if (raw !== undefined) {
    let args: unknown
    try { args = JSON.parse(raw) }
    catch (_error) { return false } // Malformed recorded arguments keep their diagnostic row visible.
    if (args !== null && typeof args === 'object' && 'sandbox_permissions' in args) return false
  }
  return block.subCalls.every(ordinaryTool)
}

/**
 * Select passive process rows; final answers and interactive feature cards stay independent.
 * @param node - Current Chat node from the recorded or streaming timeline.
 * @param turnClosed - Whether the owning Turn has actually ended.
 * @returns Whether Qianshou may put this row behind its process disclosure.
 */
export function qianshouProcessMember(node: ChatNode, turnClosed = false): boolean {
  if (node.kind === 'context') return node.data.producer.role !== 'recall'
  if (node.kind === 'system-prompt') return true
  if (node.kind === 'tool-call') return ordinaryTool(node.data.root)
  if (node.kind === 'assistant-step') {
    return node.data.status !== 'interrupted'
      && (turnClosed || !hasAssistantReplyContent(node.data.blocks))
  }
  return false
}
