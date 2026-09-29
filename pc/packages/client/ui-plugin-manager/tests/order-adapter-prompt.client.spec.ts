import { expect, it } from 'vitest'
import { orderAdapterPlanningPrompt } from '../src/client/order-adapter-prompt.ts'

it('asks the skill assistant to implement and test arbitrary skills, not merely assess an allowlist', () => {
  const prompt = orderAdapterPlanningPrompt('user-agents', 'legal-assistant-cn')
  expect(prompt).toContain('加载 plugin-author')
  expect(prompt).toContain('自动编写所需执行器')
  expect(prompt).toContain('成功和失败样例')
  expect(prompt).toContain('不要只写评估报告')
  expect(prompt).not.toContain('请评估本机技能')
  const svgPrompt = orderAdapterPlanningPrompt('user-agents', 'svg-to-video')
  expect(svgPrompt).toContain('自动编写所需执行器')
  expect(svgPrompt).not.toContain('柱状图动效试点')
})
