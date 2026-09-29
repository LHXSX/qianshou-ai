/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'connection.error': '连接异常',
  'connection.retry': '立即重连',
  'connection.connecting': '自动重连中',
  'connection.connected': '连接成功',
  'connection.reconnect': '连接异常，点击立即重连',
  'connection.restart': '连接中断，正在自动重试，点击立即重连',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'connection.error': 'Disconnected',
  'connection.retry': 'Reconnect now',
  'connection.connecting': 'Reconnecting',
  'connection.connected': 'Connected',
  'connection.reconnect': 'Disconnected, reconnect now',
  'connection.restart': 'Reconnecting automatically, reconnect now',
} satisfies Record<SettingsKey, string>

/**
 * Locale namespace of the account section. It is separate from `settings`
 * because that namespace belongs to the shell chrome and the General section,
 * whose copy is not this feature's to extend.
 */
export const ACCOUNT_NS = 'settings.account'

/**
 * Account-section copy.
 *
 * What is deliberately absent: any message describing a failed call. The
 * workbench's account routes answer failures with a user-facing sentence of
 * their own, and that sentence is displayed verbatim — a dictionary entry here
 * would replace a specific reason with a generic guess. The `error.*` entries
 * below therefore cover only transport-level facts the Host never sees.
 */
export const accountZh = {
  'nav': '账号',
  'title': '账号',
  'lead': '用你的算力账号登录。手机与电脑登录的是同一个账号：余额、任务与节点归属都是同一份。',
  'status': '登录状态',
  'status.loading': '正在读取账号状态…',
  'status.signedOut': '未登录',
  'status.signedIn': '已登录',
  'status.expired': '登录已过期',
  'account.missing': '账号信息暂不可读',
  'account': '账号',
  'email': '邮箱',
  'role': '角色',
  'balance': '余额',
  'balance.unknown': '未知',
  'lastLogin': '上次登录',
  'signedOutHint': '登录后这里会显示账号与余额。',
  'login': '登录千手账号',
  'login.identifier': '账号或邮箱',
  'login.submit': '登录',
  'login.busy': '登录中…',
  'register': '注册千手账号',
  'register.identifier': '账号（可选）',
  'register.email': '邮箱（可选）',
  'register.submit': '创建账号',
  'register.busy': '注册中…',
  'password': '密码',
  'toRegister': '还没有账号？去注册',
  'toLogin': '已有账号？去登录',
  'totp.title': '两步验证',
  'totp.code': '6 位验证码',
  'totp.trust': '信任这台设备',
  'totp.submit': '验证并登录',
  'totp.busy': '验证中…',
  'totp.back': '返回登录',
  'totpRequired': '请输入验证器里的 6 位验证码。',
  'registered': '账号已创建，请用刚设的账号登录。',
  'signedOut': '已退出登录。',
  'refresh': '刷新账号信息',
  'refresh.busy': '刷新中…',
  'logout': '退出登录',
  'logout.busy': '退出中…',
  'error.invalid': '账号服务返回的数据无法识别，没有按登录成功处理。',
  'error.unreachable': '没能连上本机的账号服务，请确认工作台在运行后重试。',
  'error.rejected': '账号服务拒绝了这次请求，但没有给出原因。',
} satisfies Record<string, string>

/** The account-section key union. */
export type AccountKey = keyof typeof accountZh

/** English dictionary, checked complete against the zh key set. */
export const accountEn = {
  'nav': 'Account',
  'title': 'Account',
  'lead': 'Sign in with your compute account. The phone and the computer sign in to the same account: one balance, one task list, one node ownership.',
  'status': 'Sign-in status',
  'status.loading': 'Reading account status…',
  'status.signedOut': 'Not signed in',
  'status.signedIn': 'Signed in',
  'status.expired': 'Session expired',
  'account.missing': 'Account details are not readable right now',
  'account': 'Account',
  'email': 'Email',
  'role': 'Role',
  'balance': 'Balance',
  'balance.unknown': 'Unknown',
  'lastLogin': 'Last sign-in',
  'signedOutHint': 'Signing in shows the account and its balance here.',
  'login': 'Sign in to Qianshou',
  'login.identifier': 'Account name or email',
  'login.submit': 'Sign in',
  'login.busy': 'Signing in…',
  'register': 'Create a Qianshou account',
  'register.identifier': 'Account name (optional)',
  'register.email': 'Email (optional)',
  'register.submit': 'Create account',
  'register.busy': 'Creating…',
  'password': 'Password',
  'toRegister': 'No account yet? Create one',
  'toLogin': 'Already have an account? Sign in',
  'totp.title': 'Two-step verification',
  'totp.code': '6-digit code',
  'totp.trust': 'Trust this device',
  'totp.submit': 'Verify and sign in',
  'totp.busy': 'Verifying…',
  'totp.back': 'Back to sign-in',
  'totpRequired': 'Enter the 6-digit code from your authenticator.',
  'registered': 'Account created. Sign in with the account you just set.',
  'signedOut': 'Signed out.',
  'refresh': 'Refresh account',
  'refresh.busy': 'Refreshing…',
  'logout': 'Sign out',
  'logout.busy': 'Signing out…',
  'error.invalid': 'The account service returned a response this page could not read, so it was not treated as a sign-in.',
  'error.unreachable': 'Could not reach the local account service. Check that the workbench is running and retry.',
  'error.rejected': 'The account service rejected this request without a reason.',
} satisfies Record<AccountKey, string>
