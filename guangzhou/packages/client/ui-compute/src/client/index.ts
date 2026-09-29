import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { ComputeController } from './controller.ts'
import { ComputePage, type ComputeFace } from './ComputePage.tsx'
import { TaskCardRow } from './TaskCardRow.tsx'
import { NS, en, forgeEn, forgeZh, zh, type ComputeKey } from './locales.ts'
import { SettingsSectionAdapter } from './settings-section.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'qianshou.compute': ComputeKey }
}
/** Runtime services used by the compute contribution. */
export const inject = ['slots', 'locale']
/** Install an optional compute workspace with reversible navigation and route contributions. */
export function apply(ctx: Context): void {
  const controller = new ComputeController()
  ctx.effect(() => () => { controller.dispose() }, 'ui-compute: request lifetime')
  const dictionaries = process.env.DSH_CLIENT_BUILD_PROFILE === 'forge' ? { en: forgeEn, zh: forgeZh } : { en, zh }
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'ui-compute: dictionaries')
  const face: ComputeFace = {
    hooks: { compute: controller.store },
    refresh: () => controller.refresh(),
    ensureLoaded: () => controller.ensureLoaded(),
    saveDraft: request => controller.saveDraft(request),
    confirmDraft: (id, decision) => controller.confirmDraft(id, decision),
    publishDraft: id => controller.publishDraft(id),
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'qianshou-compute', locale: NS, inject: () => face }, ComputePage))
  /**
   * 这一页挂在**设置**里，不再占左栏内容导航。
   *
   * 理由（用户明确要求）：左栏应该只承载"对话 + 历史会话"；而算力、设备、
   * 记忆、供给这些属于"这台机器/这个账号的状态与配置"，设置才是它们的归属地。
   * `main` 注册保留——别处已有按 id 跳转的代码，删了会连带打断那些入口。
   */
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'qianshou-compute',
    order: process.env.DSH_CLIENT_BUILD_PROFILE === 'forge' ? 3 : 11,
    label: () => ctx.locale.bind(NS)('title'),
    locale: NS,
    inject: () => ({ face }),
  }, SettingsSectionAdapter))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'compute_plan_draft',
    locale: NS,
    inject: () => face,
  }, TaskCardRow))
}

export {
  COMPUTE_TASK_CARD_PROTOCOL,
  parseComputeTaskCard,
  projectComputeTaskCard,
  type ComputeTaskCard,
  type ComputeTaskCardInput,
  type ComputeTaskCardPhase,
  type ComputeTaskCardAvailability,
  type ComputeTaskCardQuoteStatus,
  type ComputeTaskCardAuthorization,
  type ComputeTaskCardSubmission,
  type ComputeTaskCardProgressStatus,
  type ComputeTaskCardResultStatus,
} from './status-card.ts'
