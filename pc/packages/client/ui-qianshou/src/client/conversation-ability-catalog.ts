/** Read-only market selection and draft references for the composer ability board. */
import type { MarketCapability } from '@deepseek-ai/dsh-api-remotes/client'

export interface ConversationAbilityRemote {
  orderAdapterCapabilities(): Promise<
    { ok: true; value: { capabilities: readonly MarketCapability[] } }
    | { ok: false; error: { message: string } }
  >
}

/** Read current Host metadata without requesting a quote or placing an order.
 * @param remote - The existing market catalog Remote.
 * @returns The reviewed task-type catalog, or rejects when it cannot be read.
 */
export async function listConversationAbilities(remote: ConversationAbilityRemote): Promise<readonly MarketCapability[]> {
  const answer = await remote.orderAdapterCapabilities()
  if (!answer.ok) throw new Error(answer.error.message)
  return answer.value.capabilities
}

/** Only unique names with a supported conversation call contract can use the existing @ parser.
 * @param item - The current task-type entry.
 * @param catalog - The complete current catalog used by the name parser.
 * @returns Whether selection can compose an unambiguous, callable reference.
 */
export function canSelectConversationAbility(item: MarketCapability, catalog: readonly MarketCapability[]): boolean {
  const overlaps = (left: string, right: string): boolean => left === right
    || (left.startsWith(right) && /^\s/u.test(left.slice(right.length)))
  return item.availability === 'contract_ready' && item.formReady !== false
    && item.executionQuotePath !== null && item.acceptedInputKinds.some(kind => kind === 'inline' || kind === 'multi_file')
    && !catalog.some(candidate => candidate.taskType !== item.taskType
      && (overlaps(candidate.name, item.name) || overlaps(item.name, candidate.name)))
}

/** Insert a literal reference while preserving every character of the existing draft.
 * @param reference - The Host-supported /skill or @ability token.
 * @param draft - The current composer draft.
 * @returns The reference followed by the unchanged draft, without a duplicate prefix.
 */
export function conversationAbilityDraft(reference: string, draft: string): string {
  const prefix = `${reference} `
  return draft.startsWith(prefix) ? draft : prefix + draft
}
