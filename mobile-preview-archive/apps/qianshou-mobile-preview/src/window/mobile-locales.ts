/** Locale-owned copy for independent mobile agent Sessions and the PC drawer. */
const zh = {
  title: '千手 AI', cloud: '新建智能体会话', computers: '我的电脑', noPc: '无远程主机', loading: '正在查询电脑…',
  directoryError: '电脑列表查询失败，请重试', unconfigured: '远程电脑服务尚未连接', refresh: '刷新', online: '在线', offline: '离线',
  sessions: '手机会话', computerSessions: '电脑会话', conversation: '会话', send: '发送', placeholder: '和千手聊一聊', agent: '移动端智能体', running: '智能体正在工作', idle: '可以继续交流',
  unavailable: '当前会话暂不可用', signedOut: '请先登录', agentUnavailable: '移动端智能体服务尚未连接', targetError: '无法读取该会话，请重试',
  sendError: '发送结果尚未确认，请刷新查看', pcOffline: '电脑已离线，消息保留在原电脑会话', preparing: '需求准备',
  freeform: '智能体将结合上下文补齐创作要求', specified: '已保留你的要求，交由智能体规划', clarify: '智能体将继续确认所需信息',
  received: '已接收', uncertain: '接收结果未确认', rejected: '未接收', queued: '等待电脑上线', delivering: '正在发送', expired: '已过期',
  withdrawn: '已撤回', cancelled: '已取消', finished: '已结束',
} as const

type Copy = { readonly [K in keyof typeof zh]: string }
const en: Copy = {
  title: 'Qianshou AI', cloud: 'New agent conversation', computers: 'My computers', noPc: 'No remote host', loading: 'Finding computers…',
  directoryError: 'Could not load computers. Try again.', unconfigured: 'Remote computer service is not connected', refresh: 'Refresh', online: 'Online', offline: 'Offline',
  sessions: 'Phone conversations', computerSessions: 'Computer conversations', conversation: 'Conversation', send: 'Send', placeholder: 'Talk with Qianshou', agent: 'Mobile agent', running: 'Agent is working', idle: 'Ready to continue',
  unavailable: 'This conversation is unavailable', signedOut: 'Sign in to continue', agentUnavailable: 'Mobile agent service is not connected', targetError: 'Could not read this conversation. Try again.',
  sendError: 'Delivery is unconfirmed. Refresh to check.', pcOffline: 'Computer is offline. Messages stay with that computer.', preparing: 'Request preparation',
  freeform: 'The agent will use context to fill in creative details', specified: 'Your requirements are preserved for agent planning', clarify: 'The agent will clarify the missing details',
  received: 'Received', uncertain: 'Delivery unconfirmed', rejected: 'Not received', queued: 'Waiting for computer', delivering: 'Sending', expired: 'Expired',
  withdrawn: 'Withdrawn', cancelled: 'Cancelled', finished: 'Finished',
}

/**
 * Resolve product copy without inferring locale from the operating system.
 * @param locale - Explicit embedding locale.
 * @returns Typed copy for the complete workspace projection.
 */
export function mobileCopy(locale: 'zh-CN' | 'en'): Copy { return locale === 'en' ? en : zh }
