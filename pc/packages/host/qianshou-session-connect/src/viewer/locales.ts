/** Standalone browser copy, independent of the owner application's locale runtime. */
const zh = {
  title: '千手 · 会话连接', local: '由本机主人授权', explanation: '这里只显示获授权会话的已记录文字。工具、文件和权限审批仍在 PC 上处理；本页不是云备份。',
  missing: '请使用本机主人提供的有效连接链接。', loading: '正在连接 PC…', ready: '已连接 · 已记录文字已更新', running: 'PC 正在处理 · 完成记录后自动显示',
  offline: '连接中断，将重试读取。消息是否送达以回执为准。', denied: '连接已失效、到期或被撤销。请向本机主人获取新链接。',
  omitted: '当前显示近期记录；较早文字未在本页加载。', truncated: '（此条文字已截断，请在 PC 查看完整内容）',
  user: '你', assistant: '千手', read: '只读连接', text: '允许发送文字', expires: '有效期至', send: '发送到 PC', placeholder: '向这条会话发送文字',
  queued: '已送达 PC，任务仍按该会话原有权限处理。这不是任务完成回执。', uncertain: '送达状态尚不能确认。请核对回执或在 PC 查看；不要另起请求重复发送。',
  rejected: 'PC 尚未登记此请求。可使用同一编号重试。', check: '核对回执', retry: '重试同一请求', forget: '断开本页',
  session: '当前会话', bounded: '最多 4096 个字符、12 KiB。页面只保留最近 200 条文字。', invalid: '文字为空或超过输入上限。',
  storage: '连接凭据与待确认消息仅保存在此标签页，关闭标签页后清除。断开本页不撤销主人已创建的授权。', failed: '操作未成功。请检查连接或在 PC 查看。',
  device: '设备编号', deviceHint: '绑定到特定手机的授权须填写设备编号后再读取；未绑定的授权请留空。设备编号仅保存在此标签页，不会写入链接。',
}
const en: Record<keyof typeof zh, string> = {
  title: 'Qianshou · Session connection', local: 'Authorized by this device owner', explanation: 'Only committed text from the granted session appears here. Tools, files and permission approvals remain on the PC. This page is not a cloud backup.',
  missing: 'Open a valid connection link supplied by the device owner.', loading: 'Connecting to the PC…', ready: 'Connected · committed text updated', running: 'PC is working · text appears once recorded',
  offline: 'Disconnected. Reading will retry; use the receipt to check message delivery.', denied: 'This connection is invalid, expired or revoked. Ask the device owner for a new link.',
  omitted: 'Only recent records are loaded; earlier text is omitted.', truncated: '(Text truncated; see the PC for the full message.)',
  user: 'You', assistant: 'Qianshou', read: 'Read only', text: 'Text sending allowed', expires: 'Expires', send: 'Send to PC', placeholder: 'Send text to this session',
  queued: 'Received by the PC. The session keeps its existing permissions. This receipt does not mean the task has completed.', uncertain: 'Delivery cannot yet be confirmed. Check the receipt or inspect the PC; do not create another request for the same message.',
  rejected: 'The PC has not registered this request. You may retry with the same id.', check: 'Check receipt', retry: 'Retry same request', forget: 'Disconnect this page',
  session: 'Current session', bounded: 'Up to 4096 characters and 12 KiB. This page retains the latest 200 text messages.', invalid: 'Text is empty or exceeds the input limit.',
  storage: 'The credential and unconfirmed message stay in this tab only and are removed when the tab closes. Disconnecting the page does not revoke the owner’s authorization.', failed: 'The operation did not succeed. Check the connection or inspect the PC.',
  device: 'Device id', deviceHint: 'For a device-bound grant, enter the phone device id before reading. Leave blank for an unbound grant. The device id stays in this tab only and is never written into the link.',
}
/**
 * Select browser language without fetching any account profile.
 * @param language - Browser preferred language.
 * @returns Complete static product copy.
 */
export function viewerCopy(language: string): Record<keyof typeof zh, string> { return language.startsWith('zh') ? zh : en }
