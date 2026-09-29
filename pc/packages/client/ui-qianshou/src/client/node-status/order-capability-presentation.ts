/** Display-only categories for installed skills and plugin bundles. */
import type { NodeCopyKey } from './locales.ts'
export const ORDER_CATEGORIES = [
  'text', 'image', 'video', 'ppt', 'spreadsheet', 'audio', 'design', 'data', 'research',
  'automation', 'development', 'other',
] as const

export type OrderCategory = typeof ORDER_CATEGORIES[number]

/** User-facing metadata; category never determines order eligibility. */
export interface OrderCategoryInput {
  readonly category?: string | null
  readonly capabilityId?: string | null
  readonly taskType?: string | null
  readonly id?: string
  readonly title?: string
  readonly description?: string
}

type CopyKey = Extract<NodeCopyKey, `orderSkill${string}`>
type KnownSkill = { readonly category: OrderCategory; readonly name: CopyKey; readonly about: CopyKey }

// Only stable local skill IDs are mapped. Titles and descriptions from the Host are never execution authority.
const KNOWN_SKILLS: Record<string, KnownSkill> = {
  share: { category: 'development', name: 'orderSkillNameShare', about: 'orderSkillAboutShare' },
  goal: { category: 'automation', name: 'orderSkillNameGoal', about: 'orderSkillAboutGoal' },
  'create-hook': { category: 'development', name: 'orderSkillNameCreateHook', about: 'orderSkillAboutCreateHook' },
  loop: { category: 'automation', name: 'orderSkillNameLoop', about: 'orderSkillAboutLoop' },
  'split-to-prs': { category: 'development', name: 'orderSkillNameSplitPrs', about: 'orderSkillAboutSplitPrs' },
  autopilot: { category: 'development', name: 'orderSkillNameAutopilot', about: 'orderSkillAboutAutopilot' },
  origin: { category: 'development', name: 'orderSkillNameOrigin', about: 'orderSkillAboutOrigin' },
  'update-cli-config': { category: 'development', name: 'orderSkillNameCliConfig', about: 'orderSkillAboutCliConfig' },
  'update-cursor-settings': { category: 'development', name: 'orderSkillNameEditorSettings', about: 'orderSkillAboutEditorSettings' },
  'review-security': { category: 'development', name: 'orderSkillNameSecurityReview', about: 'orderSkillAboutSecurityReview' },
  'review-bugbot': { category: 'development', name: 'orderSkillNameBugReview', about: 'orderSkillAboutBugReview' },
  sdk: { category: 'development', name: 'orderSkillNameSdk', about: 'orderSkillAboutSdk' },
  automate: { category: 'automation', name: 'orderSkillNameAutomate', about: 'orderSkillAboutAutomate' },
  'create-skill': { category: 'development', name: 'orderSkillNameCreateSkill', about: 'orderSkillAboutCreateSkill' },
  'skill-creator': { category: 'development', name: 'orderSkillNameCreateSkill', about: 'orderSkillAboutCreateSkill' },
  review: { category: 'development', name: 'orderSkillNameReview', about: 'orderSkillAboutReview' },
  'create-rule': { category: 'development', name: 'orderSkillNameCreateRule', about: 'orderSkillAboutCreateRule' },
  statusline: { category: 'development', name: 'orderSkillNameStatusline', about: 'orderSkillAboutStatusline' },
  'rename-chat': { category: 'automation', name: 'orderSkillNameRenameChat', about: 'orderSkillAboutRenameChat' },
  'create-subagent': { category: 'development', name: 'orderSkillNameCreateSubagent', about: 'orderSkillAboutCreateSubagent' },
  'new-repo': { category: 'development', name: 'orderSkillNameNewRepo', about: 'orderSkillAboutNewRepo' },
  'migrate-to-skills': { category: 'development', name: 'orderSkillNameMigrateSkills', about: 'orderSkillAboutMigrateSkills' },
  shell: { category: 'development', name: 'orderSkillNameShell', about: 'orderSkillAboutShell' },
  'deploy-with-vercel': { category: 'development', name: 'orderSkillNameDeploy', about: 'orderSkillAboutDeploy' },
  canvas: { category: 'design', name: 'orderSkillNameCanvas', about: 'orderSkillAboutCanvas' },
  onboard: { category: 'automation', name: 'orderSkillNameOnboard', about: 'orderSkillAboutOnboard' },
  'pangdun-memory': { category: 'research', name: 'orderSkillNameMemory', about: 'orderSkillAboutMemory' },
  'svg-to-video': { category: 'video', name: 'orderSkillNameSvgVideo', about: 'orderSkillAboutSvgVideo' },
  'qianshou-heritage': { category: 'research', name: 'orderSkillNameHeritage', about: 'orderSkillAboutHeritage' },
}

const CATEGORY_HINTS: readonly { readonly category: OrderCategory; readonly pattern: RegExp }[] = [
  { category: 'video', pattern: /video|film|animation|motion|gif|视频|动画|动效/i },
  { category: 'ppt', pattern: /ppt|powerpoint|slide|presentation|幻灯|演示文稿/i },
  { category: 'spreadsheet', pattern: /spreadsheet|excel|xlsx|sheet|csv|表格|电子表/i },
  { category: 'image', pattern: /image|photo|picture|illustrat|绘图|图片|图像/i },
  { category: 'audio', pattern: /audio|music|voice|speech|音频|音乐|语音/i },
  { category: 'design', pattern: /design|canvas|figma|logo|海报|排版|视觉设计/i },
  { category: 'text', pattern: /writ|docx|document|pdf|article|report|写作|文案|文档|公文|论文/i },
  { category: 'data', pattern: /data|chart|visualiz|分析|可视化|数据/i },
  { category: 'research', pattern: /research|search|browse|调研|搜索|检索|资料/i },
  { category: 'automation', pattern: /automat|schedule|remind|workflow|定时|提醒|自动化|工作流/i },
  { category: 'development', pattern: /code|develop|sdk|repo|git|api|test|debug|编程|开发|代码/i },
]

function skillId(item: OrderCategoryInput): string | null {
  if (item.id?.startsWith('skill:') !== true) return null
  const name = item.id.split(':').at(-1)
  return name && /^[a-z0-9][a-z0-9-]*$/i.test(name) ? name : null
}

export function knownOrderSkill(item: OrderCategoryInput): KnownSkill | null {
  const name = skillId(item)
  return name === null ? null : KNOWN_SKILLS[name] ?? null
}

/** Classify presentation metadata without granting any execution authority. */
export function orderCategoryOf(item: OrderCategoryInput): OrderCategory {
  if (ORDER_CATEGORIES.some(category => category === item.category)) return item.category as OrderCategory
  if (item.capabilityId === 'text.transform' && item.taskType === 'word_count') return 'text'
  if (item.id === 'bundle:dshmarket') return 'development'
  const known = knownOrderSkill(item)
  if (known !== null) return known.category
  const text = `${item.id ?? ''} ${item.title ?? ''} ${item.description ?? ''}`
  return CATEGORY_HINTS.find(hint => hint.pattern.test(text))?.category ?? 'other'
}
