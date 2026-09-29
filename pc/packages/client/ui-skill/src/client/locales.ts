/** `skill` namespace dictionaries for the dedicated tool row. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'skill'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.title': 'Skill',
  'row.running': '正在加载 skill',
  'row.failed': 'skill 加载失败',
  'row.stopped': 'skill 加载已中止',
  'row.instructions': '说明',
  'row.inspect': '查看',
  'menu.userOnly': '仅用户',
  'menu.invoke': '选中后在本轮调用技能',
  'menu.local': '本机',
  'category.text': '文案与文档',
  'category.image': '图片',
  'category.video': '视频',
  'category.ppt': 'PPT',
  'category.spreadsheet': '表格',
  'category.research': '研究',
  'category.development': '开发',
  'category.automation': '自动化',
  'category.design': '设计',
  'category.data': '数据',
  'category.other': '其他技能',
} satisfies Record<string, string>

/** The skill namespace key union. */
export type SkillKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'row.title': 'Skill',
  'row.running': 'Loading skill',
  'row.failed': 'Skill load failed',
  'row.stopped': 'Skill load stopped',
  'row.instructions': 'Instructions',
  'row.inspect': 'Inspect',
  'menu.userOnly': 'user-only',
  'menu.invoke': 'Select to invoke this skill in this turn',
  'menu.local': 'On this computer',
  'category.text': 'Writing & documents',
  'category.image': 'Images',
  'category.video': 'Video',
  'category.ppt': 'Presentations',
  'category.spreadsheet': 'Spreadsheets',
  'category.research': 'Research',
  'category.development': 'Development',
  'category.automation': 'Automation',
  'category.design': 'Design',
  'category.data': 'Data',
  'category.other': 'Other skills',
} satisfies Record<SkillKey, string>
