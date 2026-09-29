/** Local skill labels keep the human title separate from its stable /command name. */
import type { LocalSkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { LocalSkillKey } from './local-skill-locales.ts'

export const CATEGORIES = [
  'text', 'image', 'video', 'ppt', 'spreadsheet', 'research',
  'development', 'automation', 'design', 'data', 'other',
] as const
export type LocalSkillCategory = typeof CATEGORIES[number]
export type SkillCopyInput = Pick<LocalSkillEntry, 'name' | 'displayName' | 'description' | 'whenToUse' | 'category'>

function copyKey(prefix: 'category' | 'about', category: LocalSkillCategory): LocalSkillKey {
  return `${prefix}${category.charAt(0).toUpperCase()}${category.slice(1)}` as LocalSkillKey
}

export function categoryLabelKey(category: LocalSkillCategory): LocalSkillKey {
  return copyKey('category', category)
}

type KnownCopy = { category: LocalSkillCategory; title: LocalSkillKey; about: LocalSkillKey }
const KNOWN: Record<string, KnownCopy> = {
  share: { category: 'development', title: 'nameShare', about: 'aboutShare' },
  goal: { category: 'automation', title: 'nameGoal', about: 'aboutGoal' },
  'create-hook': { category: 'development', title: 'nameCreateHook', about: 'aboutCreateHook' },
  loop: { category: 'automation', title: 'nameLoop', about: 'aboutLoop' },
  'split-to-prs': { category: 'development', title: 'nameSplitPrs', about: 'aboutSplitPrs' },
  autopilot: { category: 'development', title: 'nameAutopilot', about: 'aboutAutopilot' },
  origin: { category: 'development', title: 'nameOrigin', about: 'aboutOrigin' },
  'update-cli-config': { category: 'development', title: 'nameCliConfig', about: 'aboutCliConfig' },
  'update-cursor-settings': { category: 'development', title: 'nameEditorSettings', about: 'aboutEditorSettings' },
  'review-security': { category: 'development', title: 'nameSecurityReview', about: 'aboutSecurityReview' },
  'review-bugbot': { category: 'development', title: 'nameBugReview', about: 'aboutBugReview' },
  sdk: { category: 'development', title: 'nameSdk', about: 'aboutSdk' },
  automate: { category: 'automation', title: 'nameAutomate', about: 'aboutAutomate' },
  'create-skill': { category: 'development', title: 'nameCreateSkill', about: 'aboutCreateSkill' },
  'skill-creator': { category: 'development', title: 'nameCreateSkill', about: 'aboutCreateSkill' },
  review: { category: 'development', title: 'nameReview', about: 'aboutReview' },
  'create-rule': { category: 'development', title: 'nameCreateRule', about: 'aboutCreateRule' },
  statusline: { category: 'development', title: 'nameStatusline', about: 'aboutStatusline' },
  'rename-chat': { category: 'automation', title: 'nameRenameChat', about: 'aboutRenameChat' },
  'create-subagent': { category: 'development', title: 'nameCreateSubagent', about: 'aboutCreateSubagent' },
  'new-repo': { category: 'development', title: 'nameNewRepo', about: 'aboutNewRepo' },
  'migrate-to-skills': { category: 'development', title: 'nameMigrateSkills', about: 'aboutMigrateSkills' },
  shell: { category: 'development', title: 'nameShell', about: 'aboutShell' },
  'deploy-with-vercel': { category: 'development', title: 'nameDeploy', about: 'aboutDeploy' },
  canvas: { category: 'design', title: 'nameCanvas', about: 'aboutCanvas' },
  onboard: { category: 'automation', title: 'nameOnboard', about: 'aboutOnboard' },
  'pangdun-memory': { category: 'research', title: 'nameMemory', about: 'aboutMemory' },
  'svg-to-video': { category: 'video', title: 'nameSvgVideo', about: 'aboutSvgVideo' },
  'qianshou-heritage': { category: 'research', title: 'nameHeritage', about: 'aboutHeritage' },
  'legal-assistant-cn': { category: 'research', title: 'nameLegal', about: 'aboutLegal' },
  'qianshou-reverse-acceptance': { category: 'text', title: 'nameReverse', about: 'aboutReverse' },
  'qs-char-count-20260926': { category: 'text', title: 'nameCharCount', about: 'aboutCharCount' },
  'qs-char-count-20260926-v2': { category: 'text', title: 'nameCharCount', about: 'aboutCharCount' },
}

const HINTS: readonly { category: LocalSkillCategory; pattern: RegExp }[] = [
  { category: 'video', pattern: /video|film|animation|motion|gif|视频|动画|动效/i },
  { category: 'ppt', pattern: /ppt|powerpoint|slide|presentation|幻灯|演示文稿/i },
  { category: 'spreadsheet', pattern: /spreadsheet|excel|xlsx|sheet|csv|表格|电子表/i },
  { category: 'image', pattern: /image|photo|picture|illustrat|绘图|图片|图像/i },
  { category: 'design', pattern: /design|canvas|figma|logo|海报|排版|视觉设计/i },
  { category: 'text', pattern: /writ|docx|document|pdf|article|report|写作|文案|文档|公文|论文/i },
  { category: 'data', pattern: /data|chart|visualiz|分析|可视化|数据/i },
  { category: 'research', pattern: /research|search|browse|调研|搜索|检索|资料/i },
  { category: 'automation', pattern: /automat|schedule|remind|workflow|定时|提醒|自动化|工作流/i },
  { category: 'development', pattern: /code|develop|plugin|sdk|repo|git|api|test|debug|编程|开发|代码|插件/i },
]

export function categoryOfLocalSkill(skill: SkillCopyInput): LocalSkillCategory {
  if (CATEGORIES.some(category => category === skill.category)) return skill.category as LocalSkillCategory
  const known = KNOWN[skill.name]
  if (known !== undefined) return known.category
  const text = `${skill.name} ${skill.description} ${skill.whenToUse ?? ''}`
  return HINTS.find(hint => hint.pattern.test(text))?.category ?? 'other'
}

function short(text: string): string {
  const sentence = text.trim().split(/[。！？\n]/u, 1)[0] ?? ''
  return sentence.length <= 64 ? sentence : `${sentence.slice(0, 63).trimEnd()}…`
}

export function localSkillCopy(skill: SkillCopyInput, t: (key: LocalSkillKey) => string): { title: string; about: string } {
  const known = KNOWN[skill.name]
  const category = categoryOfLocalSkill(skill)
  const title = /[\u3400-\u9fff]/u.test(skill.displayName)
    ? skill.displayName : known === undefined
      ? (/^[\u3400-\u9fff]/u.test(skill.description.trim())
          ? short(skill.description).split(/[：:；;]/u, 1)[0]!.slice(0, 28) : skill.displayName || skill.name)
      : t(known.title)
  const about = /[\u3400-\u9fff]/u.test(skill.description)
    ? short(skill.description) : known === undefined ? t(copyKey('about', category)) : t(known.about)
  return { title, about }
}
