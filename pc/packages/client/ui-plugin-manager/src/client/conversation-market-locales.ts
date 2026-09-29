/** Copy for Session-owned market call cards. */
import { en as progressEn, zh as progressZh } from './market-task-progress-locales.ts'
export const zh = {
  ...progressZh,
  title: '本对话的市场任务',
  request: '你发送的请求',
  session: '所属对话',
  price: '本次报价',
  selectedProductVersion: '已选择商品版本',
  invalid: '本对话有一条无法恢复的市场记录。请先核查任务回执，勿重复发单。',
}
export const en: Record<keyof typeof zh, string> = {
  ...progressEn,
  title: 'Market tasks in this conversation',
  request: 'Your request',
  session: 'Conversation',
  price: 'Quoted price',
  selectedProductVersion: 'Selected product version',
  invalid: 'A saved market call could not be restored. Check its task receipt before submitting again.',
}
export type ConversationMarketKey = keyof typeof zh
