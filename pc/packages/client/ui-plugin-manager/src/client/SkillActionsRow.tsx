/** Host file and execution receipts expose actions in the original authoring conversation. */
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { LocalSkillTrial, type LoadLocalSkillTrial, type RunLocalSkillTrial } from './LocalSkillTrial.tsx'
import type { MarketplacePublicationFocus } from './marketplace-navigation-contract.ts'
import css from './SkillActionsRow.module.css'

/** Persisted Host metadata is required; assistant prose and unsettled calls have no actions.
 * @param block - Persisted tool row read by the conversation renderer.
 * @returns A bounded saved/executed skill receipt, or null for other rows.
 */
export function skillActionsFromToolResult(block: ToolCallViewProps['block']): ({
  state: 'saved' | 'local-trial'
  name: string
  source: 'user-dsh' | 'user-agents'
  title: string
  portableTrial: boolean
}) | null {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- Recorded tool rows also include unsettled presentations.
  if (!('kind' in block) || block.kind !== 'tool-result' || block.isError) return null
  const meta = block.meta
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null
  const value = meta as Record<string, unknown>
  if (value.protocol !== 'qianshou.skill-actions.v1' || !['saved', 'local-trial'].includes(String(value.state))
    || (value.source !== 'user-dsh' && value.source !== 'user-agents')
    || typeof value.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.name)
    || typeof value.portableTrial !== 'boolean') return null
  if (value.state === 'saved' && (typeof value.skillSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.skillSha256))) return null
  if (value.state === 'local-trial' && (typeof value.artifactDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.artifactDigest))) return null
  return { state: value.state as 'saved' | 'local-trial', name: value.name, source: value.source,
    title: typeof value.displayName === 'string' ? value.displayName : value.name, portableTrial: value.portableTrial }
}

/** Show existing local trial and publication management actions after a Host receipt.
 * @param props - Tool result, existing executor, exact-source navigation and locale.
 * @returns Author actions without inferring review or device readiness.
 */
export function SkillActionsRow({ block, run, load, manage, t }: Pick<ToolCallViewProps, 'block'>
  & PropsLocale<'qianshou.localSkills'> & { run: RunLocalSkillTrial; load?: LoadLocalSkillTrial | undefined;
    manage: (focus: MarketplacePublicationFocus) => boolean }) {
  const skill = skillActionsFromToolResult(block)
  if (skill === null) return null
  return <section className={css.card} data-skill-actions={skill.state}>
    <header><strong>{skill.title}</strong><span>{t(skill.state === 'local-trial' ? 'trialPassed' : 'authorSaved')}</span></header>
    <p>{t('authorActionsExplain')}</p>
    {skill.portableTrial ? <LocalSkillTrial source={skill.source} name={skill.name} run={run} load={load}
      prepare={() => { manage({ source: skill.source, name: skill.name }) }} t={t} />
      : <Button variant="outline" size="sm" onClick={() => { manage({ source: skill.source, name: skill.name }) }}>{t('trialStart')}</Button>}
    <Button size="sm" onClick={() => { manage({ source: skill.source, name: skill.name }) }}>{t('publishOrder')}</Button>
  </section>
}
