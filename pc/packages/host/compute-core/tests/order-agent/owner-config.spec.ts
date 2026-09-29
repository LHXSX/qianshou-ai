/**
 * 主人配置面的闸：**默认关** + 凭据只许写"引用" + 工具目录闭合 + 预算有界。
 *
 * 这些用例跑得快、无副作用，但每一条都对着一条铁律：
 * 1. 默认 `builtin`（铁律 #1）；
 * 2. 凭据的值**不许**出现在配置里（铁律 #2）；
 * 3. 工具白名单**默认空**、目录闭合、未知项不静默丢（铁律 #3）；
 * 4. 预算每一格都有默认值，越界即判非法（铁律 #6）。
 */
import { describe, expect, it } from 'vitest'
import {
  ORDER_AGENT_DEFAULT_BUDGET,
  ORDER_AGENT_MAX_SUBAGENT_DEPTH_CEILING,
  ORDER_AGENT_REFUSAL_CODES,
  ORDER_AGENT_TOOL_CATALOG,
  ORDER_AGENT_TOOL_IDS,
  ORDER_AGENT_TOOL_IMPLEMENTATIONS_SHIPPED_HERE,
  OWNER_AGENT_CONFIG_OFF,
  toolActionClasses,
  validateOwnerAgentConfig,
  type OrderAgentToolId,
} from '../../src/order-agent/owner-config.ts'

/** 一个"看着像凭据"的值（用例里从不当真用）。 */
const CREDENTIAL_SHAPED = 'sk-live-0123456789abcdefghijklmnop'

/** 校验通过时的配置（失败即抛出用例自己的断言）。 */
function accepted(raw: unknown) {
  const validation = validateOwnerAgentConfig(raw)
  expect(validation.ok, `期望配置被接受，实际：${JSON.stringify(validation)}`).toBe(true)
  if (!validation.ok) throw new Error('unreachable')
  return validation
}

/** 校验失败时的结论。 */
function refusedAt(raw: unknown, field: string) {
  const validation = validateOwnerAgentConfig(raw)
  expect(validation.ok).toBe(false)
  if (validation.ok) throw new Error('unreachable')
  expect(validation.code).toBe(ORDER_AGENT_REFUSAL_CODES.configInvalid)
  expect(validation.field).toBe(field)
  return validation
}

describe('主人配置面：默认关', () => {
  it('没给配置 ⇒ builtin、无账户、空白名单、零子代理、默认预算', () => {
    for (const raw of [undefined, null, {}]) {
      const { config } = accepted(raw)
      expect(config.mode).toBe('builtin')
      expect(config.account).toBeNull()
      expect(config.authorizedTools).toEqual([])
      expect(config.maxSubagentDepth).toBe(0)
      expect(config.allowUnreportedCost).toBe(false)
      expect(config.budget).toEqual(ORDER_AGENT_DEFAULT_BUDGET)
    }
    expect(OWNER_AGENT_CONFIG_OFF.mode).toBe('builtin')
    expect(ORDER_AGENT_DEFAULT_BUDGET.maxToolCalls).toBe(0)
    expect(ORDER_AGENT_DEFAULT_BUDGET.maxSubagentDispatches).toBe(0)
  })

  it('档位是没见过的值 ⇒ 判非法（不猜、不取默认值）', () => {
    const refused = refusedAt({ mode: 'gpu' }, 'mode')
    expect(refused.detail).toContain('不猜')
  })

  it('ceo 但没有账户 ⇒ 配置合法，但**留一条 note**说这一档会明确失败', () => {
    const { config, notes } = accepted({ mode: 'ceo' })
    expect(config.mode).toBe('ceo')
    expect(config.account).toBeNull()
    expect(notes.join('\n')).toContain(ORDER_AGENT_REFUSAL_CODES.modelAccountMissing)
  })
})

describe('主人配置面：凭据只许写"引用"', () => {
  it('credential 带 value 字段 ⇒ 判非法（凭据的值不许进配置）', () => {
    const refused = refusedAt({
      mode: 'ceo',
      account: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        credential: { kind: 'environment', variable: 'QIANSHOU_MODEL_API_KEY', value: 'whatever' },
        maxOutputTokens: 1024,
      },
    }, 'account.credential')
    expect(refused.detail).toContain('凭据的**值**不许出现在配置里')
  })

  it('别处粘进一份凭据字面量 ⇒ 判非法（不给它进仓库的机会）', () => {
    refusedAt({ mode: 'ceo', account: { provider: 'deepseek', model: CREDENTIAL_SHAPED, credential: { kind: 'environment', variable: 'K' }, maxOutputTokens: 8 } }, 'account.model')
    refusedAt({ mode: 'ceo', account: { provider: `Bearer ${CREDENTIAL_SHAPED.slice(3)}`, model: 'm', credential: { kind: 'environment', variable: 'K' }, maxOutputTokens: 8 } }, 'account.provider')
    const long = refusedAt({ account: { provider: 'p'.repeat(300), model: 'm', credential: { kind: 'environment', variable: 'K' }, maxOutputTokens: 8 } }, 'account.provider')
    expect(long.detail).toContain('长字符串')
  })

  it('环境变量名必须是机器名形状（不许把值当名字）', () => {
    refusedAt({ mode: 'ceo', account: { provider: 'p', model: 'm', credential: { kind: 'environment', variable: 'my key' }, maxOutputTokens: 8 } }, 'account.credential.variable')
  })

  it('账户形状合法 ⇒ 原样带出 provider/model/变量名与单次输出上限', () => {
    const { config } = accepted({
      mode: 'ceo',
      account: {
        provider: 'deepseek', model: 'deepseek-chat',
        credential: { kind: 'environment', variable: 'QIANSHOU_MODEL_API_KEY' },
        maxOutputTokens: 2048,
      },
    })
    expect(config.account?.provider).toBe('deepseek')
    expect(config.account?.credential).toEqual({ kind: 'environment', variable: 'QIANSHOU_MODEL_API_KEY' })
    expect(config.account?.maxOutputTokens).toBe(2048)
  })
})

describe('主人配置面：工具目录闭合', () => {
  it('目录每一项都声明了动作类别与有没有副作用；本工单一实现都不提供', () => {
    expect(Object.keys(ORDER_AGENT_TOOL_CATALOG).sort()).toEqual([...ORDER_AGENT_TOOL_IDS].sort())
    for (const id of ORDER_AGENT_TOOL_IDS) {
      const declaration = ORDER_AGENT_TOOL_CATALOG[id]
      expect(declaration.id).toBe(id)
      expect(declaration.actionClasses.length).toBeGreaterThan(0)
      expect(typeof declaration.sideEffect).toBe('boolean')
      expect(declaration.detail.length).toBeGreaterThan(0)
    }
    // 涉文件/网络/进程的一律有副作用标记：白名单外"永远不许发生"的那一类。
    expect(ORDER_AGENT_TOOL_CATALOG['fs.write'].sideEffect).toBe(true)
    expect(ORDER_AGENT_TOOL_CATALOG['net.http'].actionClasses).toEqual(['network'])
    expect(ORDER_AGENT_TOOL_CATALOG['process.spawn'].actionClasses).toEqual(['process'])
    expect(ORDER_AGENT_TOOL_IMPLEMENTATIONS_SHIPPED_HERE).toEqual([])
    expect(toolActionClasses('not-a-tool')).toEqual([])
    expect(toolActionClasses('fs.read')).toEqual(['file'])
  })

  it('白名单里的未知工具 ⇒ 判非法（不静默丢）', () => {
    const refused = refusedAt({ authorizedTools: ['fs.read', 'rm-rf'] }, 'authorizedTools[1]')
    expect(refused.detail).toContain('不静默丢')
  })

  it('同一个工具写两遍 ⇒ 判非法（重复项不静默收敛）', () => {
    refusedAt({ authorizedTools: ['fs.read', 'fs.read'] }, 'authorizedTools[1]')
  })

  it('未知字段（顶层/account/budget）一律判非法：会被静默忽略的字段正是缺陷', () => {
    refusedAt({ mode: 'ceo', capabilityMode: 'ceo' }, '<root>')
    refusedAt({ account: { provider: 'p', model: 'm', credential: { kind: 'environment', variable: 'K' }, maxOutputTokens: 8, apiKey: 'x' } }, 'account')
    refusedAt({ budget: { maxTokens: 1 } }, 'budget')
  })

  it('白名单非空但 maxToolCalls=0 ⇒ 合法但留 note（工具会被预算闸拦下）', () => {
    const { notes } = accepted({ authorizedTools: ['fs.read'] })
    expect(notes.join('\n')).toContain('maxToolCalls=0')
  })

  it('builtin 档位下点了账户/白名单 ⇒ 合法但留 note（不生效）', () => {
    const { notes } = accepted({
      mode: 'builtin',
      authorizedTools: ['fs.read'],
      account: { provider: 'p', model: 'm', credential: { kind: 'environment', variable: 'K' }, maxOutputTokens: 8 },
    })
    expect(notes.join('\n')).toContain('不生效')
  })
})

describe('主人配置面：有界', () => {
  it('agent.dispatch 在白名单里但深度上限为 0 ⇒ 判非法（不猜主人的意思）', () => {
    const refused = refusedAt({ authorizedTools: ['agent.dispatch'] }, 'maxSubagentDepth')
    expect(refused.detail).toContain('必须显式给出深度上限')
  })

  it('深度上限超过硬顶 ⇒ 判非法', () => {
    refusedAt({ authorizedTools: ['agent.dispatch'], maxSubagentDepth: ORDER_AGENT_MAX_SUBAGENT_DEPTH_CEILING + 1 }, 'maxSubagentDepth')
    accepted({ authorizedTools: ['agent.dispatch'], maxSubagentDepth: ORDER_AGENT_MAX_SUBAGENT_DEPTH_CEILING })
  })

  it('深度的两道闸分开：允许派子代理不等于允许无限深度', () => {
    const { config, notes } = accepted({ maxSubagentDepth: 2 })
    expect(config.maxSubagentDepth).toBe(2)
    expect(config.authorizedTools).toEqual([])
    expect(notes.join('\n')).toContain('第二道闸')
  })

  it('预算每一格越界的取值都判非法（不静默取默认）', () => {
    refusedAt({ budget: { maxModelCalls: -1 } }, 'budget.maxModelCalls')
    refusedAt({ budget: { maxModelCalls: 2.5 } }, 'budget.maxModelCalls')
    refusedAt({ budget: { wallClockMs: 0 } }, 'budget.wallClockMs')
    refusedAt({ budget: { maxCostMicroUsd: 10_000_000_000 } }, 'budget.maxCostMicroUsd')
  })

  it('预算只给一格 ⇒ 其余格取默认（可逐格收紧）', () => {
    const { config } = accepted({ budget: { maxModelCalls: 7 } })
    expect(config.budget.maxModelCalls).toBe(7)
    expect(config.budget.wallClockMs).toBe(ORDER_AGENT_DEFAULT_BUDGET.wallClockMs)
    expect(config.budget.maxTotalTokens).toBe(ORDER_AGENT_DEFAULT_BUDGET.maxTotalTokens)
  })

  it('成本上限默认是"未知不算通过"：不许静默放宽', () => {
    const { config } = accepted({})
    expect(config.allowUnreportedCost).toBe(false)
    refusedAt({ allowUnreportedCost: 'yes' }, 'allowUnreportedCost')
  })
})

describe('主人配置面：白名单是唯一的工具授权来源', () => {
  it('白名单只由配置决定；任务文本里的任何说法都不是它的输入', () => {
    // 结构闸：这个模块不读任务文本，也没有任何"从文本推工具"的入口。
    const source = validateOwnerAgentConfig.toString()
    expect(source).not.toContain('inlineInput')
    const { config } = accepted({ authorizedTools: ['fs.read'] as OrderAgentToolId[] })
    expect(config.authorizedTools).toEqual(['fs.read'])
  })
})
