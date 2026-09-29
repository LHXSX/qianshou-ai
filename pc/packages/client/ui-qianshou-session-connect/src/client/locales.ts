/** Owner-facing text for explicit local Session grants. */
export const zh = {
  title: '会话连接', close: '关闭', introTitle: '创建仅查看私密链接',
  description: '默认只允许查看这段会话，60 分钟后到期。需要改权限或时间时再打开连接设置。',
  permission: '允许发送文字时，对方可在这条会话发起工作，继续使用该会话已有的权限。工具审批、文件操作和停止任务仍由本机处理。',
  reachability: '当前默认仅限这台电脑使用。要从手机或其他设备打开，需先配置可达的 HTTPS 地址。',
  reachabilityTitle: '当前可使用范围', localDevice: '仅当前电脑', localOnly: '这是本机回环地址，只能在这台电脑打开。手机和其他设备无法通过此链接连接。',
  httpsConfigured: '已配置 HTTPS 地址', httpsCheck: '从其他设备使用前，仍需在该设备验证地址和网络确实可达。', reachabilityUnknown: '尚未读到连接地址。',
  newConnection: '新建连接', label: '链接备注（可选）', labelPlaceholder: '例如：另一窗口', defaultLabel: '会话查看链接', mode: '允许的操作', read: '仅查看（默认）', text: '查看并发送文字', duration: '有效时间（分钟）',
  advanced: '连接设置 · 权限与有效期', deviceSettings: '设备标记（可选）', bindingNote: '设备 ID 由访问端自行填写，仅做字符串核对；PC ID 只用于记录。两者都不能验证设备身份，请妥善保管私密链接。',
  deviceId: '设备 ID', deviceIdPlaceholder: '可选；绑定一台设备', pcId: 'PC ID', pcIdPlaceholder: '可选；绑定一台 PC',
  create: '创建私密链接', createRead: '创建仅查看私密链接', createText: '创建可发送文字的链接', creating: '正在创建…', link: '私密连接链接', oneTime: '仅显示一次',
  createdTitle: '链接已创建', createdHint: '完整链接只在这里显示一次，请先复制。', createAnother: '再创建一个链接',
  linkWarning: '持有链接的人可在有效期内访问这条会话。请只发给可信的人；关闭窗口后无法找回完整链接。',
  copy: '复制链接', copied: '已复制', copyFailed: '复制未成功，请手动选择链接复制。', grants: '连接记录', empty: '尚未为这条会话创建连接。',
  revoke: '撤销', revoked: '已撤销', expired: '已到期', active: '有效', lastAccess: '最近读取', never: '尚未读取', received: '已送达条数', expires: '到期',
  refresh: '刷新状态', retry: '重试读取', failed: '操作未成功。原会话保持不变；请刷新状态后重试。', invalid: '请选择 1 至平台允许上限内的有效时间。',
  invalidId: '设备 ID 与 PC ID 须为 1 至 256 个可见字符，且不能包含控制字符；留空表示不绑定。',
  unavailable: '连接服务当前不可用。', loading: '正在读取连接状态…', noSecret: '旧链接不会再次显示；如需新链接可再次创建，不再使用的连接可撤销。',
}
/** Keys are shared by both owner UI languages. */
export type ConnectKey = keyof typeof zh
/** Complete English owner copy. */
export const en: Record<ConnectKey, string> = {
  title: 'Session connection', close: 'Close', introTitle: 'Create a view-only private link',
  description: 'The default link can only view this session and expires in 60 minutes. Open connection settings to change permissions or time.',
  permission: 'Allowing text lets the recipient start work in this session with its existing permissions. Tool approvals, file operations and stopping tasks stay on the PC.',
  reachability: 'By default, the link works only on this computer. Phones and other devices need a reachable HTTPS address configured first.',
  reachabilityTitle: 'Current access scope', localDevice: 'This computer only', localOnly: 'This is a local loopback address. Phones and other devices cannot open this link.',
  httpsConfigured: 'HTTPS address configured', httpsCheck: 'Before using another device, verify that the address and network are actually reachable from that device.', reachabilityUnknown: 'Connection address has not been read.',
  newConnection: 'New connection', label: 'Link note (optional)', labelPlaceholder: 'For example: another window', defaultLabel: 'Session view link', mode: 'Allowed actions', read: 'View only (default)', text: 'View and send text', duration: 'Lifetime (minutes)',
  advanced: 'Connection settings · permission and lifetime', deviceSettings: 'Device labels (optional)', bindingNote: 'The visitor supplies Device ID for a string match; PC ID is recorded only. Neither verifies device identity. Keep the private link safe.',
  deviceId: 'Device ID', deviceIdPlaceholder: 'Optional; bind one device', pcId: 'PC ID', pcIdPlaceholder: 'Optional; bind one PC',
  create: 'Create private link', createRead: 'Create view-only private link', createText: 'Create a link that can send text', creating: 'Creating…', link: 'Private connection link', oneTime: 'Shown once',
  createdTitle: 'Link created', createdHint: 'The full link is shown only once. Copy it now.', createAnother: 'Create another link',
  linkWarning: 'Anyone with the link can access this session until it expires. Share it only with trusted people. The full link cannot be recovered after closing this window.',
  copy: 'Copy link', copied: 'Copied', copyFailed: 'Copy failed. Select and copy the link manually.', grants: 'Connection history', empty: 'No connections have been created for this session.',
  revoke: 'Revoke', revoked: 'Revoked', expired: 'Expired', active: 'Active', lastAccess: 'Last read', never: 'Not read yet', received: 'Received messages', expires: 'Expires',
  refresh: 'Refresh status', retry: 'Retry loading', failed: 'The operation did not succeed. The session is unchanged; refresh the connection status before retrying.', invalid: 'Choose a lifetime from 1 minute up to the platform limit.',
  invalidId: 'Device ID and PC ID must be 1 to 256 visible characters without control characters; leave blank to leave unbound.',
  unavailable: 'The connection service is currently unavailable.', loading: 'Loading connection status…', noSecret: 'Existing links are never shown again. Create another link if needed and revoke links you no longer use.',
}
