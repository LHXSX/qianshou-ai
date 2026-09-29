/**
 * **后端自检**：逐个验证每个后端"端点可达 + 密钥有效 + 真的能出正文"。
 *
 * 为什么需要它：后端来自不同厂商（DeepSeek 与阿里云），端点与密钥都是**各自一套**。
 * 换绑之后如果哪个后端不通，表现只会是"用户发消息报错"，而看不出是哪一环断了。
 * 这个脚本把每个后端单独打一次，先于用户发现坏掉的那个。
 *
 * **绝不打印密钥**：只报告来源与长度。
 * 跑法：
 *   PATH=/opt/homebrew/bin:$PATH node node_modules/tsx/dist/cli.mjs \
 *     packages/host/model-gateway/tools/verify-backends-live.mjs
 * 退出码非 0 表示有后端不通。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BACKENDS } from '../src/tiers.ts'

/**
 * 从凭据文件的 `refs:` 段取一个键；只认最简单的 `key: value` 形状。
 *
 * **与插件里的解析保持一致：两个位置都找**。实测这台机器上密钥分散在两处
 * （DeepSeek 在 `$DSH_HOME`，通义在另一个 harness home），只读一处会出现
 * "密钥明明配了、却说没配"——而症状与真的没配完全一样。
 * 脚本与插件是两份实现，这里刻意把顺序写死成一样，免得日后漂移。
 * @param ref - 引用名（`refs:` 段的键）。
 * @returns 值，或 `null`。
 */
function keyFromCredentialsFile(ref) {
  const homes = [
    process.env['DSH_HOME'] ?? join(homedir(), '.dsh'),
    join(homedir(), '.local', 'share', 'qianshou-agent', 'home'),
  ]
  for (const home of homes) {
    const found = refFromFile(join(home, '.credentials.yaml'), ref)
    if (found !== null) return found
  }
  return null
}

/**
 * 从一个文件里取某个键。
 * @param path - 凭据文件路径。
 * @param ref - 引用名。
 * @returns 值，或 `null`。
 */
function refFromFile(path, ref) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.startsWith('refs:'))
  if (start === -1) return null
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) break
    const match = new RegExp(`^\\s+${ref}:\\s*(\\S.*)$`).exec(line)
    if (match !== null && match[1].trim().length > 0) return match[1].trim()
  }
  return null
}

/** 每个后端只打一次**最小**请求：一两句话、给足输出预算。 */
async function probe(backend) {
  const key = process.env[backend.credentialRef]?.trim() || keyFromCredentialsFile(backend.credentialRef)
  if (key === null || key === undefined || key.length === 0) {
    return { ok: false, why: `凭据文件里没有 ${backend.credentialRef}` }
  }
  const started = Date.now()
  let response
  try {
    response = await fetch(`${backend.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: backend.id,
        messages: [{ role: 'user', content: '只回复两个字：收到' }],
        // 给足预算：会推理的模型把推理 token 也算在里面，给小了正文会一个字都没有。
        max_tokens: 256,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    return { ok: false, why: `请求失败：${String(error).slice(0, 80)}` }
  }
  const body = await response.text()
  if (!response.ok) return { ok: false, why: `HTTP ${response.status}：${body.slice(0, 120)}` }
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
  if (text.trim().length === 0) {
    return { ok: false, why: `上游回了 ${body.length} 字节但正文为空（可能是预算被推理吃光，或模型名不对）` }
  }
  return { ok: true, why: `正文=${JSON.stringify(text.trim())} 用量=${usage?.prompt_tokens ?? '?'}+${usage?.completion_tokens ?? '?'} 耗时=${Date.now() - started}ms`, keyLength: key.length }
}

let failed = 0
for (const [key, backend] of Object.entries(BACKENDS)) {
  const result = await probe(backend)
  if (!result.ok) failed += 1
  const mark = result.ok ? '✓' : '✗'
  console.log(`${mark} ${key.padEnd(6)} ${backend.id}`)
  console.log(`   端点 ${backend.baseUrl}`)
  console.log(`   密钥 ${backend.credentialRef}${result.keyLength === undefined ? '' : `（长度 ${result.keyLength}）`}`)
  console.log(`   ${result.why}`)
  console.log()
}
console.log(failed === 0 ? '全部后端可用。' : `${failed} 个后端不可用。`)
process.exit(failed === 0 ? 0 : 1)
