/** `sidebar` namespace dictionaries for shell controls and global panels. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'session.new': '新会话',
  'session.new.label': '新建会话',
  'session.new.hint': '从一个想法，开始交付',
  'workbench.label': '个人开发工作台',
  'workbench.description': '代码 · 工具 · 自动化',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
  'panels.label': '全局面板',
  'panels.heading': '工作台工具',
  'nav.chat': '对话',
  'brand.product': '千手 AI',
} satisfies Record<string, string>

/** The sidebar namespace key union. */
export type SidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'session.new': 'New Session',
  'session.new.label': 'New session',
  'session.new.hint': 'Take an idea into production',
  'workbench.label': 'Personal developer workspace',
  'workbench.description': 'Code · Tools · Automation',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
  'panels.label': 'Global panels',
  'panels.heading': 'Workbench tools',
  'nav.chat': 'Chat',
  'brand.product': 'Qianshou AI',
} satisfies Record<SidebarKey, string>

/** Qianshou product copy selected only by the forge client build. */
export const forgeZh = {
  ...zh,
  'session.new': '新建对话',
  'session.new.label': '新建对话',
  'session.new.hint': '开始一轮新的协作',
  'workbench.label': '千手 AI',
  'workbench.description': '一群AI，为你而来',
  'panels.label': '功能导航',
  'panels.heading': '功能',
} satisfies Record<SidebarKey, string>

/** English counterpart of the forge product sidebar copy. */
export const forgeEn = {
  ...en,
  'session.new': 'New chat',
  'session.new.label': 'New chat',
  'session.new.hint': 'Start a new collaboration',
  'workbench.label': 'Qianshou AI',
  'workbench.description': 'A team of AI, here for you',
  'panels.label': 'Features',
  'panels.heading': 'Features',
} satisfies Record<SidebarKey, string>
