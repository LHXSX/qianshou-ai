/** `settings.theme` namespace dictionaries (the Appearance and font-size rows' copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'appearance.title': '外观',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.system': '跟随系统',
  'appearance.obsidian': '曜石黑',
  // 深色主色由金色改为蓝色（见 qianshou-palettes.ts 的 BLACK）——
  // 预览文案必须跟着走，否则用户点进去会看到与描述不符的颜色。
  'appearance.obsidianDetail': '纯黑层次 · 黄色点缀',
  'appearance.cloud': '云雾白',
  'appearance.cloudDetail': '纯白留白 · 一点蓝',
  'appearance.skinDetail': '为整个工作台选择氛围',
  'appearance.systemDetail': '随系统自动切换黑色与白色',
  'fontSize.title': '字号大小',
  'fontSize.description': '仅影响会话内容的字号',
  'fontSize.unit': 'px',
  'fontSize.increase': '增大字号',
  'fontSize.decrease': '减小字号',
} satisfies Record<string, string>

/** The settings.theme namespace key union. */
export type ThemeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'appearance.obsidian': 'Obsidian',
  'appearance.obsidianDetail': 'True black · gold accent',
  'appearance.cloud': 'Cloud',
  'appearance.cloudDetail': 'Pure white · a touch of blue',
  'appearance.skinDetail': 'Set the mood for your whole workspace',
  'appearance.systemDetail': 'Switch between black and white with your system',
  'fontSize.title': 'Font size',
  'fontSize.description': 'Only affects conversation content',
  'fontSize.unit': 'px',
  'fontSize.increase': 'Increase font size',
  'fontSize.decrease': 'Decrease font size',
} satisfies Record<ThemeKey, string>
