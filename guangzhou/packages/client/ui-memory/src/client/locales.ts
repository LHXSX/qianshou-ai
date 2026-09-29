/** Dictionary owned by the local memory workspace. */
export const NS = 'qianshou.memory'
/** Chinese copy for records, evidence, and explicit review actions. */
export const zh = {
  title: '记忆与知识', heading: '留下有用的事，保留判断的依据。',
  description: '原文、来源和修改记录都在这里。候选经验经你确认后，才用于常规检索。',
  temporary: '临时记忆', permanent: '长期记忆', knowledge: '知识资料', experience: '经验',
  all: '全部层级', active: '已确认', candidate: '待确认经验',
  create: '新建条目', import: '导入文本', export: '导出 JSON', refresh: '刷新',
  search: '搜索标题与原文', searchAction: '搜索', workspaceFilter: '按工作区绝对路径筛选',
  empty: '这里还没有符合条件的条目', emptyHint: '可以新建，或导入文本、Markdown、代码与 JSON 资料。',
  loading: '正在读取本机记忆…', error: '操作没有完成', detail: '原文与依据',
  choose: '选择一条记录，查看原文和版本。', entryTitle: '标题', content: '原文', kind: '记忆层级',
  scope: '使用范围', personal: '此本机账号', workspace: '指定工作区', workspacePath: '工作区绝对路径',
  scopeHint: '此本机账号的已确认内容可供其员工使用；工作区内容按指定路径隔离。',
  source: '来源', evidence: '证据与验证说明', sourceHint: '文件名、网址或你记录这条内容的出处',
  evidenceHint: '写下实际检查过什么、结果在哪里，以及尚未确认的部分。',
  days: '临时保留天数（1–90）', expires: '到期时间', noExpiry: '没有设置到期时间',
  revision: '版本', bytes: '原文字节数', created: '创建', updated: '更新',
  save: '保存条目', discard: '放弃修改', remove: '永久删除',
  deleteConfirm: '永久删除这条记录及其全部历史版本和原文？此操作无法撤销。',
  discardConfirm: '放弃这条记录尚未保存的修改？',
  accept: '确认这条经验', reject: '不采纳', rejectConfirm: '不采纳并移除这条候选经验及其历史记录？',
  candidateHint: '这是尚未确认的候选经验。请检查原文和依据后再确认，不能直接视为事实。',
  versions: '历史版本', noVersions: '暂无历史版本', savedSource: '保存的来源',
  previous: '上一页', next: '下一页', pageCount: '{start}–{end} / {total} 条',
  importHint: '支持 UTF-8 纯文本、Markdown、代码与 JSON，单文件不超过 512 KiB；不解析 PDF 或图片。',
  importTooLarge: '文件超过 512 KiB，请先拆分成较小的文本。',
  importUnsupported: '请选择支持的纯文本、Markdown、代码或 JSON 文件。',
  importInvalid: '文件不是有效的 UTF-8 纯文本，无法作为原文导入。',
  invalid: '请填写标题、非空原文与有效范围；临时保留天数为 1–90。',
  tooLarge: '原文超过 512 KiB，请拆分为多个条目。',
  exportFailed: '导出没有完成，请重试。',
} as const
/** Locale keys shared by the page and sidebar. */
export type MemoryKey = keyof typeof zh
/** English counterpart of all memory workspace copy. */
export const en: Record<MemoryKey, string> = {
  title: 'Memory & knowledge', heading: 'Keep what helps, together with its evidence.',
  description: 'Source text, provenance, and revisions stay visible. Candidate experience enters normal search only after your review.',
  temporary: 'Temporary', permanent: 'Long-term', knowledge: 'Knowledge', experience: 'Experience',
  all: 'All layers', active: 'Confirmed', candidate: 'Pending experience',
  create: 'New entry', import: 'Import text', export: 'Export JSON', refresh: 'Refresh',
  search: 'Search titles and source text', searchAction: 'Search', workspaceFilter: 'Filter by absolute workspace path',
  empty: 'No entries match these filters', emptyHint: 'Create an entry or import text, Markdown, code, and JSON sources.',
  loading: 'Reading local memory…', error: 'The operation did not complete', detail: 'Source & evidence',
  choose: 'Select an entry to inspect its source and revisions.', entryTitle: 'Title', content: 'Source text', kind: 'Memory layer',
  scope: 'Scope', personal: 'This local account', workspace: 'Specific workspace', workspacePath: 'Absolute workspace path',
  scopeHint: 'Confirmed account entries can be used by its employees; workspace entries stay scoped to the selected path.',
  source: 'Source', evidence: 'Evidence and verification', sourceHint: 'Filename, URL, or the origin of this information',
  evidenceHint: 'Describe what was actually checked, where results live, and what remains uncertain.',
  days: 'Keep for days (1–90)', expires: 'Expires', noExpiry: 'No expiration set',
  revision: 'Revision', bytes: 'Source bytes', created: 'Created', updated: 'Updated',
  save: 'Save entry', discard: 'Discard changes', remove: 'Delete permanently',
  deleteConfirm: 'Permanently delete this entry, all historical revisions, and source text? This cannot be undone.',
  discardConfirm: 'Discard the unsaved changes to this entry?',
  accept: 'Confirm this experience', reject: 'Dismiss', rejectConfirm: 'Dismiss and remove this candidate and its revision history?',
  candidateHint: 'This is unconfirmed candidate experience. Inspect the source and evidence before accepting it as fact.',
  versions: 'Revision history', noVersions: 'No earlier revisions', savedSource: 'Stored source',
  previous: 'Previous', next: 'Next', pageCount: '{start}–{end} of {total}',
  importHint: 'Import UTF-8 text, Markdown, code, or JSON, up to 512 KiB per file. PDFs and images are not parsed.',
  importTooLarge: 'This file exceeds 512 KiB. Split it into smaller text sources.',
  importUnsupported: 'Choose a supported plain-text, Markdown, code, or JSON file.',
  importInvalid: 'This is not valid UTF-8 plain text and cannot be imported as source.',
  invalid: 'Enter a title, nonempty source text, and valid scope. Temporary retention must be 1–90 days.',
  tooLarge: 'Source text exceeds 512 KiB. Split it into multiple entries.',
  exportFailed: 'Export did not complete. Please retry.',
}

/** Product-nav title used only by the forge client build. */
export const forgeZh = { ...zh, title: '知识库' } as const satisfies Record<MemoryKey, string>
/** English counterpart of the forge memory navigation title. */
export const forgeEn = { ...en, title: 'Knowledge' } as const satisfies Record<MemoryKey, string>
