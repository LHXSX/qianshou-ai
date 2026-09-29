/**
 * 受理层拒绝要回帧给平台 · 运行时侧。
 *
 * 为什么单独钉这两条：拒绝是在 `admission.ts` 里按策略判出来的（`USER_ACTIVE` 等），
 * 那时**还没有执行器、也没有结果**，所以平台唯一的线索就是这一帧；而通道又是"可选"的
 * （`ResidentSession.sendDecision?`），可选意味着**很容易整条悄悄没有**。这里用真的运行时
 * 驱动，断言它确实把决定交给了会话，且不打扰正常受理。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { TestResidentNode } from './harness.ts'

const nodes: TestResidentNode[] = []

async function node(options: Parameters<typeof TestResidentNode.create>[0] = {}): Promise<TestResidentNode> {
  const created = await TestResidentNode.create(options)
  nodes.push(created)
  return created
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map(async (created) => { await created.dispose() }))
})

describe('admission refusals are handed to the session', () => {
  it('reports USER_ACTIVE with the exact attempt tuple when the owner is using the machine', async () => {
    const subject = await node({ policy: { allowWhileUserActive: false }, snapshot: { userActive: true } })
    await subject.runtime.start()
    const offer = subject.offer('task-refused-by-policy')
    await subject.pushOffer(offer)
    const tick = await subject.runtime.tickOnce()

    // 本地投影里照样有这次拒绝（原有行为不变）……
    expect(tick.outcomes[0]).toMatchObject({ accepted: false, refusal: 'USER_ACTIVE' })
    // ……并且它同时被交给会话，平台才不会等到租约过期。
    const session = subject.sessions()[0]
    expect(session?.decisionEvents()).toEqual([
      expect.objectContaining({ decision: 'refused', reason: 'USER_ACTIVE', taskId: 'task-refused-by-policy', attempt: 1 }),
    ])
    expect(session?.returnFrames()).toHaveLength(0)
  })

  it('does not report a decision for an offer it accepted', async () => {
    const subject = await node({ policy: { allowWhileUserActive: true }, snapshot: { userActive: true } })
    await subject.runtime.start()
    await subject.pushOffer(subject.offer('task-accepted-while-active'))
    const tick = await subject.runtime.tickOnce()
    expect(tick.outcomes[0]).toMatchObject({ accepted: true })
    // 受理不需要这一帧：心跳与随后的结果已经表达了它。
    expect(subject.sessions()[0]?.decisionEvents()).toEqual([])
  })
})
