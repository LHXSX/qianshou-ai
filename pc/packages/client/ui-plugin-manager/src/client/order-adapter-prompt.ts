/** Start real adapter creation in the skill assistant; platform publication still needs a price and receipt. */
export function orderAdapterPlanningPrompt(source: 'user-dsh' | 'user-agents', name: string): string {
  const label = JSON.stringify(name.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 120))
  const location = source === 'user-dsh' ? '应用技能目录' : '个人技能目录'
  const intro = `我点击了“发布接单技能”，请直接把本机技能 ${label}（${location}）补成可试用的执行能力，不要只写评估报告。先加载 plugin-author，读取这项技能实际做法；自动编写所需执行器、严格输入输出合同、成功和失败样例，其中成功样例至少两个输入不同且结果可核对、结果校验，以及源包内 canonical UTF-8 的 task-definition.json 机器合同（任务类型、输入表单、平台已加载的输入与结果校验策略 ID），不要让我手填 JSON。把合同和样例纳入同一签名包，在隔离环境跑通后安装并在真实对话调用。缺什么就自己补、修复后重试；平台若尚无能独立核验该任务结果的策略，明确说明阻断，不得冒充已可接单。只有业务输入或外部授权无法确定时才问我。完成后只用简短中文告诉我“能做什么、试用结果、发布还差什么”。发布时让我确认人民币价格，并以平台真实受理和审核回执为准；不能把本机可用说成已上架。`
  return intro
}
