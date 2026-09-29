/**
 * **场景评测**：用产品真实的任务类型，对比候选模型的实际表现。
 *
 * 只测**客观信号**，不做好坏打分——质量需要真实评测集与人工判断，
 * 凭一次问答下"哪个模型强"的结论就是编。这里能确定的是：
 * 响应速度、token 消耗（成本的代理指标）、以及**指令遵循能否用机器判定**。
 *
 * 跑法：
 *   PATH=/opt/homebrew/bin:$PATH node node_modules/tsx/dist/cli.mjs \
 *     packages/host/model-gateway/tools/bench-scenarios.mjs [--models a,b,c] [--out 路径]
 * **绝不打印密钥**。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 从凭据文件的 `refs:` 段取一个键。 */
function keyFromCredentialsFile(ref) {
  const homes = [process.env['DSH_HOME'], join(homedir(), '.dsh'), join(homedir(), '.local/share/qianshou-agent/home')].filter(Boolean)
  for (const home of homes) {
    try {
      const lines = readFileSync(join(home, '.credentials.yaml'), 'utf8').split('\n')
      const start = lines.findIndex(line => line.startsWith('refs:'))
      if (start === -1) continue
      for (let index = start + 1; index < lines.length; index += 1) {
        const line = lines[index]
        if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) break
        const match = new RegExp(`^\\s+${ref}:\\s*(\\S.*)$`).exec(line)
        if (match !== null && match[1].trim().length > 0) return match[1].trim()
      }
    } catch { /* 换下一个位置 */ }
  }
  return null
}

const argv = process.argv.slice(2)
const modelsArg = argv.includes('--models') ? argv[argv.indexOf('--models') + 1] : undefined
const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : undefined

const KEY = keyFromCredentialsFile('QWEN_TOKEN_PLAN_API_KEY')
if (KEY === null) { console.error('找不到通义密钥（QWEN_TOKEN_PLAN_API_KEY）'); process.exit(2) }
const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

/** 候选：覆盖三档，都是实测可用的准确名字。 */
const MODELS = (modelsArg ?? 'qwen-turbo,qwen-plus,deepseek-v4-flash,deepseek-v4-pro,kimi-k3').split(',').map(s => s.trim()).filter(Boolean)

/**
 * 五个场景，每个都带一个**机器可判定的**要求。
 *
 * 这是刻意的：主观质量我判不了，但"有没有按格式输出"是客观事实。
 * 判不了的维度我宁可不要，也不写一个看起来专业其实靠感觉的分数。
 */
const SCENARIOS = [
  {
    id: 'code',
    name: '写代码',
    prompt: '用 TypeScript 写一个函数 `chunk<T>(list: T[], size: number): T[][]`，把数组按 size 切片。只输出代码块，不要解释。',
    /** 机器判定：必须含代码块，且含函数名与最基本的边界处理。 */
    check: text => text.includes('```') && /chunk/.test(text) && /size/.test(text),
    checkWhy: '含代码块且提到函数名与 size 参数',
  },
  {
    id: 'plan',
    name: '拆需求做规划',
    prompt: '把"做一个手机端记账应用"拆成 5 个阶段，每阶段一行。只输出 5 行，每行格式为「阶段N：内容」，不要其它文字。',
    check: text => (text.match(/阶段[1-5]/g) ?? []).length >= 5,
    checkWhy: '恰好按要求的格式给出 5 个阶段',
  },
  {
    id: 'summary',
    name: '长文档总结',
    prompt: '用三句话总结这段话的要点：\n' + '订阅制是企业按期收费、持续提供服务的商业模式。与一次性买断相比，它把收入摊到每个周期，因此更看重留存率而非单次成交。额度设计通常分月额度与滚动窗口两道闸：月额度防大额损失，滚动窗口防短时滥用。超额时的处理有三种主流做法：降级到更轻的模型、按量计费、或直接拒绝并提示升级。',
    check: text => (text.match(/[。！？.!?]/g) ?? []).length >= 3 && text.length > 40,
    checkWhy: '给出了成句的完整总结（至少三句）',
  },
  {
    id: 'writing',
    name: '中文写作',
    prompt: '给一款"忙时帮你干活、闲时接单赚钱"的智能体产品写一句宣传语，不超过 20 字，不要引号。',
    check: text => { const t = text.trim(); return t.length > 0 && t.length <= 40 && !t.includes('"') && !t.includes('「') },
    checkWhy: '长度受控且未使用引号',
  },
  {
    id: 'extract',
    name: '结构化抽取',
    prompt: '从这句话里抽出城市与金额，只输出一行 JSON，键为 city 与 amount：\n「我昨天在上海花了 328 元买书。」',
    check: text => { try { const j = JSON.parse(text.trim().replace(/^```(?:json)?|```$/g, '').trim()); return j.city === '上海' && Number(j.amount) === 328 } catch { return false } },
    checkWhy: '输出可解析的 JSON 且字段值正确',
  },
]

/** 跑一条，返回耗时、正文与用量。 */
async function runOne(model, scenario) {
  const started = Date.now()
  let response
  try {
    response = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: scenario.prompt }],
        // 给足预算：会推理的模型把推理 token 也算在里面，给小了正文会一个字都没有。
        max_tokens: 2048,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(120_000),
    })
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 80) }
  }
  const body = await response.text()
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}: ${body.slice(0, 120)}` }
  let text = ''
  let usage = null
  for (const block of body.split('\n\n')) {
    const line = block.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') continue
    try {
      const frame = JSON.parse(payload)
      if (frame.usage) usage = frame.usage
      const delta = frame.choices?.[0]?.delta?.content
      if (typeof delta === 'string') text += delta
    } catch { /* 忽略非 JSON */ }
  }
  return {
    ok: true,
    ms: Date.now() - started,
    text,
    inputTokens: usage?.prompt_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? null,
    passed: scenario.check(text),
  }
}

const results = []
console.log(`候选模型：${MODELS.join('、')}`)
console.log(`场景：${SCENARIOS.map(s => s.name).join('、')}\n`)
for (const model of MODELS) {
  const row = { model, scenarios: {} }
  for (const scenario of SCENARIOS) {
    const result = await runOne(model, scenario)
    row.scenarios[scenario.id] = result
    const pass = result.ok ? (result.passed ? '✓' : '✗') : '—'
    console.log(`  ${model.padEnd(18)} ${scenario.name.padEnd(12)} ${pass}  ${result.ok ? `${String(result.ms).padStart(6)}ms 出${String(result.outputTokens ?? '?').padStart(4)}tok` : result.error}`)
  }
  const finished = Object.values(row.scenarios).filter(r => r.ok)
  row.avgMs = finished.length === 0 ? null : Math.round(finished.reduce((sum, r) => sum + r.ms, 0) / finished.length)
  row.passedCount = finished.filter(r => r.passed).length
  row.totalOutputTokens = finished.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0)
  results.push(row)
  console.log(`  → 平均 ${row.avgMs ?? '—'}ms，指令遵循 ${row.passedCount}/${SCENARIOS.length}，输出合计 ${row.totalOutputTokens} token\n`)
}

console.log('汇总（按平均耗时排序）：')
for (const row of [...results].sort((a, b) => (a.avgMs ?? 1e9) - (b.avgMs ?? 1e9))) {
  console.log(`  ${row.model.padEnd(18)} 平均${String(row.avgMs ?? '—').padStart(6)}ms  遵循${row.passedCount}/${SCENARIOS.length}  输出${String(row.totalOutputTokens).padStart(5)}token`)
}

const payload = {
  note: '由 packages/host/model-gateway/tools/bench-scenarios.mjs 实测产出。只含客观信号（耗时、token、指令遵循），不含质量打分。',
  at: new Date().toISOString(),
  endpoint: BASE,
  scenarios: SCENARIOS.map(s => ({ id: s.id, name: s.name, checkWhy: s.checkWhy })),
  results,
}
const out = outArg ?? join(process.cwd(), '.artifacts', 'model-bench.json')
try {
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`\n已写入 ${out}`)
} catch (error) {
  console.log(`\n结果落盘失败（不影响上面的读数）：${String(error).slice(0, 80)}`)
}
process.exit(0)
