/** Chinese menu copy never changes the command used to load a skill. */
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'

const known: Record<string, [string, string, string]> = {
  automate: ['自动化任务', '创建提醒、定时任务和监控', 'automation'],
  autopilot: ['维护合并请求', '检查审查意见、冲突与构建', 'development'],
  canvas: ['交互画布', '制作可交互的展示画布', 'design'],
  'create-hook': ['创建事件钩子', '为智能体事件添加脚本', 'development'],
  'create-rule': ['创建规则', '编写长期生效的工作规则', 'development'],
  'create-skill': ['创建技能', '制作可复用的技能说明', 'development'],
  'create-subagent': ['创建专属智能体', '配置适合特定任务的助手', 'development'],
  'deploy-with-vercel': ['部署网站', '将网站发布到托管平台', 'development'],
  goal: ['设置目标', '设定持续推进的任务目标', 'automation'],
  'legal-assistant-cn': ['中国法律助理', '审查合同、梳理证据和起草文书', 'research'],
  loop: ['定时循环', '按时间间隔重复运行任务', 'automation'],
  'migrate-to-skills': ['迁移旧规则', '把旧规则和命令转为技能', 'development'],
  'new-repo': ['新建项目仓库', '保存并上传项目仓库', 'development'],
  'office-docx': ['Word 文档', '创建和编辑文档、报告与表格', 'text'],
  'office-pptx': ['PPT 演示文稿', '创建和编辑幻灯片', 'ppt'],
  'office-xlsx': ['Excel 表格', '整理数据、公式和电子表格', 'spreadsheet'],
  onboard: ['新手引导', '完成初次使用设置', 'automation'],
  origin: ['仓库连接', '配置项目仓库的登录与连接', 'development'],
  'pangdun-memory': ['项目记忆', '查阅项目历史和工作偏好', 'research'],
  'qianshou-heritage': ['千手资产导航', '查找项目资产和资料', 'research'],
  'qianshou-reverse-acceptance': ['文本反转验收', '测试文字逆序处理', 'text'],
  'qs-char-count-20260926': ['字符统计测试', '统计中文和表情字符', 'text'],
  'qs-char-count-20260926-v2': ['字符统计测试新版', '统计中文和表情字符', 'text'],
  'rename-chat': ['重命名会话', '修改当前对话标题', 'automation'],
  review: ['代码审查', '审查代码改动', 'development'],
  'review-bugbot': ['代码缺陷审查', '检查潜在的代码缺陷', 'development'],
  'review-security': ['安全审查', '检查代码安全问题', 'development'],
  sdk: ['智能体 SDK', '将智能体接入程序', 'development'],
  share: ['保存与分享项目', '备份和分享当前项目', 'development'],
  shell: ['运行命令', '执行指定的终端命令', 'development'],
  'split-to-prs': ['拆分代码审查', '将大改动拆成小型合并请求', 'development'],
  statusline: ['状态栏设置', '配置命令行状态栏', 'development'],
  'svg-to-video': ['SVG 转视频', '将绘图制作成视频和动图', 'video'],
  'update-cli-config': ['命令行设置', '配置命令行工具', 'development'],
  'update-cursor-settings': ['编辑器设置', '调整编辑器配置', 'development'],
}

export function chineseSkillMenuCopy(skill: SkillEntry): { label: string; about: string; category: string } {
  const copy = known[skill.name]
  const authored = skill.displayName?.trim()
  const label = authored && /[\u3400-\u9fff]/u.test(authored) ? authored : copy?.[0] ?? authored ?? skill.name
  const about = /[\u3400-\u9fff]/u.test(skill.description)
    ? skill.description.split(/[。！？\n]/u, 1)[0] ?? '' : copy?.[1] ?? '本机可用技能'
  return { label, about: about.length > 48 ? `${about.slice(0, 47)}…` : about,
    category: skill.category ?? copy?.[2] ?? 'other' }
}
