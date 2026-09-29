/** Locale-owned Chinese copy for web and native update notices. */
export const appUpdatesCopy = {
  title: '版本与更新',
  description: '网页内容随服务更新；原生能力升级需安装新版本。',
  check: '检查更新',
  automatic: '自动检查更新',
  checking: '正在核对版本…',
  openDownloads: '前往官网下载',
  nativeAvailable: '有新的安装包。请从官网下载并按系统提示安装。',
  testingAvailable: '有新的 Android 测试包，使用测试签名。请先在官网查看适用范围，再决定是否安装。',
  webAvailable: '网页版本已更新。请先发送或保存草稿，再手动重新打开页面。',
  nativePending: '网页版本已核对；此平台的安装包尚未开放下载。',
  current: '当前已是最新可用版本。',
  unavailable: '暂时无法检查更新，请稍后重试。当前版本仍可继续使用。',
  platform: { android: 'Android', harmony: '鸿蒙' },
  webVersion: (version: string): string => `网页版本 ${version}`,
  nativeVersion: (platform: string, native: string, web: string): string => `${platform} ${native} · 网页 ${web}`,
} as const
