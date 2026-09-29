/** Verify the product's actual standing agent compositions before Desktop readiness. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'

/**
 * Mount the shipped Qianshou modes without creating a Session or calling a model.
 * @param ctx - Running Host composition with its real preset owner.
 * @param profile - Product identity inherited from immutable Desktop metadata.
 */
export async function verifyDesktopAgentStartup(ctx: Context, profile: string | undefined): Promise<void> {
  if (profile !== 'qianshou') return
  const presets = ctx.get('agentPresets')
  if (presets === undefined) throw new Error('desktop agent startup: preset service is unavailable')
  for (const id of ['qianshou-ceo', 'qianshou-skill-creator', 'qianshou-call']) {
    try { await presets.standingKeyFor(id) }
    catch (cause) { throw new Error(`desktop agent startup: ${id} could not mount`, { cause }) }
  }
}
