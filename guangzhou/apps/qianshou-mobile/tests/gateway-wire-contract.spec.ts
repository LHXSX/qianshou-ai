/**
 * 契约测试：用**网关真实发出的字节**检验手机端解析器。
 *
 * 为什么必须有这一层：手机端的测试一直对着**自己写的假网关**跑，网关的测试对着
 * **自己造的假响应**跑。两边都绿，合起来仍然可能坏——字段名差一个字母就够了
 * （`downgradeNote` 写成 `downgrade`、`requestedModel` 写成 `requested`……）。
 *
 * 样本来源：`packages/host/model-gateway/tools/capture-wire.mjs`。它启动真实网关、
 * 打一个本地 SSE 上游、把网关**真正吐出的 SSE 字节**原样存进
 * `tests/fixtures/gateway-wire.json`。这里就是把那些字节喂给手机端解析器。
 *
 * 因此：**若网关改了帧结构，抓取脚本会产出新样本，这份测试就会红。**
 * 刷新样本：
 *   `PATH=/opt/homebrew/bin:$PATH node node_modules/tsx/dist/cli.mjs packages/host/model-gateway/tools/capture-wire.mjs --write`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseGatewayFrame } from '../src/subscription.ts'

/** 真实字节样本。 */
interface WireFixture {
  readonly note: string
  readonly chatPath: string
  readonly success: string
  readonly downgraded: string
  readonly rejectedQuota: string
  readonly rejectedUnknownModel: string
  readonly rejectedBadBody: string
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'gateway-wire.json'), 'utf8'),
) as WireFixture

/**
 * 把一段真实 SSE 字节按手机端的方式切帧并解析。
 *
 * 刻意**照抄**运行时的切帧方式（按空行分事件、取 `data:` 之后的内容），
 * 而不是用正则"聪明地"抽 JSON——否则测的就不是真实解析路径了。
 * @param raw - 网关吐出的原始字节。
 * @returns 解析成功的帧（丢掉的帧也一并记录，便于断言）。
 */
function framesOf(raw: string): { readonly parsed: NonNullable<ReturnType<typeof parseGatewayFrame>>[]; readonly dropped: string[] } {
  const parsed: NonNullable<ReturnType<typeof parseGatewayFrame>>[] = []
  const dropped: string[] = []
  for (const block of raw.split('\n\n')) {
    const line = block.trim()
    if (line.length === 0) continue
    // 非 SSE 的整包响应（网关在请求体不合法时就是回 JSON）不属于帧。
    if (!line.startsWith('data:')) { dropped.push(line); continue }
    const frame = parseGatewayFrame(line.slice(5).trim())
    if (frame === null) dropped.push(line)
    else parsed.push(frame)
  }
  return { parsed, dropped }
}

describe('契约：手机端解析器对真实网关字节', () => {
  it('样本确实是网关抓来的，不是手写的', () => {
    expect(fixture.note).toContain('capture-wire.mjs')
    expect(fixture.chatPath).toBe('/api/qianshou/ai/chat')
  })

  it('成功路径：两个增量 + 一个 done，没有丢帧', () => {
    const { parsed, dropped } = framesOf(fixture.success)
    expect(dropped).toEqual([])
    expect(parsed.filter(frame => frame.type === 'delta').map(frame => frame.type)).toEqual(['delta', 'delta'])
    const done = parsed.find(frame => frame.type === 'done')
    expect(done).toBeDefined()
    if (done?.type === 'done') {
      expect(done.model).toBe('千手·迅捷')
      expect(done.requestedModel).toBe('千手·迅捷')
      expect(done.downgraded).toBe(false)
      expect(done.chargedSp).toBe(0.07)
    }
  })

  it('增量文字与网关发出的完全一致（没有被转义或截断）', () => {
    const { parsed } = framesOf(fixture.success)
    const text = parsed.filter(frame => frame.type === 'delta').map(frame => frame.type === 'delta' ? frame.text : '').join('')
    expect(text).toBe('你好，世界')
  })

  it('降级路径：requestedModel 与 model 不同，且带上可显示的说明', () => {
    const { parsed, dropped } = framesOf(fixture.downgraded)
    expect(dropped).toEqual([])
    const done = parsed.find(frame => frame.type === 'done')
    expect(done).toBeDefined()
    if (done?.type === 'done') {
      // 这正是"降级必须可见"在客户端一侧的落点：两个字段不同就是降级了。
      expect(done.requestedModel).toBe('千手·强力')
      expect(done.model).toBe('千手·迅捷')
      expect(done.downgraded).toBe(true)
      expect(done.note).toContain('千手·迅捷')
    }
  })

  it('拒绝路径：status 是机器可读的，分类可据此判断', () => {
    const { parsed, dropped } = framesOf(fixture.rejectedQuota)
    expect(dropped).toEqual([])
    const error = parsed.find(frame => frame.type === 'error')
    expect(error).toBeDefined()
    if (error?.type === 'error') {
      expect(error.status).toBe(400)
      expect(error.message).toContain('64000')
    }
  })

  it('未知模型：status 是 404，说明里不出现上游厂商标识', () => {
    const { parsed } = framesOf(fixture.rejectedUnknownModel)
    const error = parsed.find(frame => frame.type === 'error')
    if (error?.type === 'error') {
      expect(error.status).toBe(404)
      expect(error.message).not.toContain('deepseek')
    }
  })

  it('请求体不合法时网关回的是整包 JSON，不是 SSE（解析器不该把它当成帧）', () => {
    const { parsed, dropped } = framesOf(fixture.rejectedBadBody)
    expect(parsed).toEqual([])
    // 它不是帧，但也不是"被丢弃的坏帧"——消费端要能识别出这是整包响应。
    expect(dropped.length).toBe(1)
    expect(dropped[0]).toContain('请求格式不对')
  })

  it('整份样本里没有上游厂商标识（前台只显示我们的名字）', () => {
    for (const raw of [fixture.success, fixture.downgraded, fixture.rejectedQuota, fixture.rejectedUnknownModel]) {
      expect(raw).not.toContain('deepseek')
    }
  })
})
