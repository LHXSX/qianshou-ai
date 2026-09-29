/** B 工单：基础图像执行器的判定规则（不跑真 ffmpeg；真机验证另做）。 */
import { describe, expect, it, vi } from 'vitest'
import { createBasicImageExecutor, IMAGE_EXECUTOR_REFUSALS } from '../../src/executors/image-basic.ts'

const OK_SPAWN = async () => ({ code: 0, stdout: '', stderr: '' })

describe('createBasicImageExecutor', () => {
  it('拒绝非法输入：宽高必须为正整数（不许"尽量试试"）', async () => {
    const ex = createBasicImageExecutor({ spawn: vi.fn(OK_SPAWN) })
    await expect(ex.run({ width: 0, height: 10, outPath: '/tmp/x.png' })).rejects.toMatchObject({ code: IMAGE_EXECUTOR_REFUSALS.BAD_INPUT })
  })

  it('依赖缺失（ENOENT）⇒ 明确失败，绝不返回占位图', async () => {
    const ex = createBasicImageExecutor({ spawn: vi.fn(async () => ({ code: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }) })) })
    await expect(ex.run({ width: 8, height: 8, outPath: '/tmp/none.png' })).rejects.toMatchObject({ code: IMAGE_EXECUTOR_REFUSALS.DEPENDENCY_MISSING })
  })

  it('退出码非零 ⇒ RUN_FAILED 且带 stderr 末行', async () => {
    const ex = createBasicImageExecutor({ spawn: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'Invalid argument\n' })) })
    await expect(ex.run({ width: 8, height: 8, outPath: '/tmp/none.png' })).rejects.toMatchObject({ code: IMAGE_EXECUTOR_REFUSALS.RUN_FAILED })
  })

  it('超时 ⇒ TIMEOUT（不许挂死节点）', async () => {
    const ex = createBasicImageExecutor({ spawn: vi.fn(async () => ({ code: null, stdout: '', stderr: '', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })) })
    await expect(ex.run({ width: 8, height: 8, outPath: '/tmp/none.png' })).rejects.toMatchObject({ code: IMAGE_EXECUTOR_REFUSALS.TIMEOUT })
  })

  it('"命令返回 0"但产物读不到 ⇒ EMPTY_ARTIFACT（这是失败，不是成功）', async () => {
    const ex = createBasicImageExecutor({ spawn: vi.fn(OK_SPAWN) })
    await expect(ex.run({ width: 8, height: 8, outPath: '/tmp/绝不存在的目录-abc/x.png' })).rejects.toMatchObject({ code: IMAGE_EXECUTOR_REFUSALS.EMPTY_ARTIFACT })
  })

  it('执行前已中止 ⇒ ABORTED，且不起进程', async () => {
    const spawn = vi.fn(OK_SPAWN)
    const c = new AbortController(); c.abort()
    const ex = createBasicImageExecutor({ spawn })
    await expect(ex.run({ width: 8, height: 8, outPath: '/tmp/x.png' }, c.signal)).rejects.toMatchObject({ code: IMAGE_EXECUTOR_REFUSALS.ABORTED })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('声明的能力名是 image.basic（待与平台注册表核对，不许偷偷换成别的）', () => {
    expect(createBasicImageExecutor({ spawn: vi.fn(OK_SPAWN) }).capability).toBe('image.basic')
  })

  it('产物合法时返回事实（路径/字节/哈希/宽高），不做"我觉得对了"的判断', async () => {
    // 用真文件路径让 stat/readFile 成功
    const fs = await import('node:fs/promises')
    const out = '/tmp/image-basic-spec-artifact.png'
    await fs.writeFile(out, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const ex = createBasicImageExecutor({ spawn: vi.fn(OK_SPAWN) })
    const r = await ex.run({ width: 4, height: 4, outPath: out, prompt: '画一张图' })
    expect(r.bytes).toBe(7)
    expect(r.sha256).toHaveLength(64)
    expect(r.width).toBe(4)
    expect(r.note).toContain('仅留档')
    await fs.rm(out, { force: true })
  })
})
