import type { MarketInputLabels } from './MarketInputFields.tsx'

/** Labels supplied to the plain form renderer by the product surface. */
export const marketInputLabelsZh: MarketInputLabels = {
  content: '内容', optional: '选填', choose: '请选择', yes: '是', no: '否', add: '添加一项', remove: '移除',
}

export const marketInputLabelsEn: MarketInputLabels = {
  content: 'Content', optional: 'Optional', choose: 'Choose', yes: 'Yes', no: 'No', add: 'Add item', remove: 'Remove',
}

/** Display labels distinguish accepted dispatch from observed executor startup. */
export const marketTaskStatusZh = {
  received: '已提交，中央服务器正在安排执行。',
  waiting: '等待设备接手', executing: '正在执行', checking: '正在核验结果',
  unconfirmed: '已受理，正在核查执行状态',
  CREATED: '已提交', PLANNED: '正在安排执行', WAITING_FOR_WORKERS: '等待可用设备',
  NORMALIZING: '正在准备输入', DONE: '已完成', FAILED: '任务未完成',
  CANCELLED: '已取消', CANCELED: '已取消',
  pendingBuyer: '待你验收', quarantine: '待核查', details: '任务详情',
}

export const marketTaskStatusEn: Record<keyof typeof marketTaskStatusZh, string> = {
  received: 'Submitted. The central server is arranging execution.',
  waiting: 'Waiting for a device', executing: 'Executing', checking: 'Checking the result',
  unconfirmed: 'Accepted; checking execution status',
  CREATED: 'Submitted', PLANNED: 'Arranging execution', WAITING_FOR_WORKERS: 'Waiting for an available device',
  NORMALIZING: 'Preparing input', DONE: 'Completed', FAILED: 'Task did not complete',
  CANCELLED: 'Cancelled', CANCELED: 'Cancelled',
  pendingBuyer: 'Awaiting your acceptance', quarantine: 'Needs verification', details: 'Task details',
}
