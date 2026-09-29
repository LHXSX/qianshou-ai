/**
 * B 工单：第二种能力 —— 基础图像执行器。
 *
 * 用户的话：「我的电脑上有 h3 模型 或者有出图的模型 …… 就代表这个节点有能力」。
 * 本模块做的是**这条链里"会干"的那一环**：拿到图类任务能真的产出一张图。
 *
 * 设计约束（每条都对应本会话踩过的坑）：
 * 1. **真产出**：用本机 `ffmpeg`（已实测 `invoked=true ok=true`，version 8.0.1）生成真实 PNG/JPEG。
 * 2. **依赖缺失 ⇒ 明确失败**：绝不返回占位图、绝不静默降级（`EXECUTOR_DEPENDENCY_MISSING`）。
 * 3. **空产物 = 失败**：产物字节数为 0 或读不到 ⇒ `EXECUTOR_EMPTY_ARTIFACT`。
 *    （对应真实事故：N9 那份"形状错"的实现 `name/bytes/sha256` 全合法却读不出预期字段。）
 * 4. **不许自证**：本模块只**产出 + 报事实**（路径/字节数/哈希/宽高）；合不合格由**独立校验**判。
 *    ⇒ 所以这里**不做**"我觉得没问题"的判断，只做"文件真的写出来了吗"这种可复核的事实。
 * 5. **有界**：外部调用有超时（默认 30s），可注入、可中止。
 * 6. **契约名待对齐**：`capability` 暂用 `image.basic`；**平台注册表里的契约名必须核对后再上报**，
 *    对齐不上**不许自己发明一个名字就宣称可用**（见报告"待对齐"一节）。
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 本执行器对外声称的能力标识（**待与平台注册表核对**）。 */
export const BASIC_IMAGE_CAPABILITY = 'image.basic'

export const IMAGE_EXECUTOR_REFUSALS = Object.freeze({
  /** 依赖（ffmpeg）不在或起不来 —— 绝不用占位图顶上。 */
  DEPENDENCY_MISSING: 'EXECUTOR_DEPENDENCY_MISSING',
  /** 依赖在但执行失败（退出码非零）。 */
  RUN_FAILED: 'EXECUTOR_RUN_FAILED',
  /** 执行"成功"但产物是空的/读不到 —— 这是失败，不是成功。 */
  EMPTY_ARTIFACT: 'EXECUTOR_EMPTY_ARTIFACT',
  /** 超时。 */
  TIMEOUT: 'EXECUTOR_TIMEOUT',
  /** 输入不合法（尺寸为 0 等）。 */
  BAD_INPUT: 'EXECUTOR_BAD_INPUT',
  /** 被中止。 */
  ABORTED: 'EXECUTOR_ABORTED',
} as const)

export interface ImageTaskInput {
  /** 目标宽高（像素）；必须为正整数。 */
  readonly width: number
  readonly height: number
  /** 颜色（ffmpeg 颜色语法，如 `0x1F6FEB`）；缺省为深蓝。 */
  readonly color?: string
  readonly format?: 'png' | 'jpg'
  /** 产物落到哪（由调用方决定工作目录 —— 执行器不自己挑位置）。 */
  readonly outPath: string
  /** 任务带来的文字要求（**不可信输入**：本执行器不解析它，只留档）。 */
  readonly prompt?: string
}

export interface ImageTaskOutput {
  readonly artifactPath: string
  readonly format: string
  readonly width: number
  readonly height: number
  readonly bytes: number
  /** 产物哈希 —— 给独立校验用的**事实**，不是"我觉得对了"。 */
  readonly sha256: string
  readonly note?: string
}

export interface ImageExecutorFailure {
  readonly code: string
  readonly detail: string
}

export class ImageExecutorError extends Error {
  readonly code: string
  readonly detail: string
  constructor(failure: ImageExecutorFailure) {
    super(`${failure.code}: ${failure.detail}`)
    this.code = failure.code
    this.detail = failure.detail
  }
}

export interface SpawnResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: Error & { code?: string }
}
export type Spawn = (command: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }) => Promise<SpawnResult>

const defaultSpawn: Spawn = (command, args, options) =>
  new Promise<SpawnResult>(resolve => {
    execFile(command, [...args], { timeout: options.timeoutMs, signal: options.signal, encoding: 'utf8' }, (error, stdout, stderr) => {
      const err = error as (Error & { code?: string | number }) | null
      if (err) {
        const base = { code: typeof err.code === 'number' ? err.code : null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
        resolve(typeof err.code === 'string' ? { ...base, error: err as Error & { code?: string } } : base)
        return
      }
      resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })

export interface BasicImageExecutorOptions {
  readonly spawn?: Spawn
  readonly timeoutMs?: number
  /** ffmpeg 可执行文件路径；缺省 `ffmpeg`（在 PATH 里）。 */
  readonly ffmpegPath?: string
}

export interface BasicImageExecutor {
  readonly capability: string
  /** 只产出 + 报事实；**不判定自己成功**。 */
  readonly run: (input: ImageTaskInput, signal?: AbortSignal) => Promise<ImageTaskOutput>
}

/**
 * 用 ffmpeg 的 `lavfi` 生成一张纯色图 —— 这是"最小真实图像产出"：
 * 不依赖模型权重，却真的写出一个能被独立解码/校验的图片文件。
 */
export function createBasicImageExecutor(options: BasicImageExecutorOptions = {}): BasicImageExecutor {
  const spawn = options.spawn ?? defaultSpawn
  const timeoutMs = options.timeoutMs ?? 30_000
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg'

  return {
    capability: BASIC_IMAGE_CAPABILITY,
    async run(input, signal) {
      if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) {
        throw new ImageExecutorError({ code: IMAGE_EXECUTOR_REFUSALS.BAD_INPUT, detail: `宽高必须为正整数：${input.width}x${input.height}` })
      }
      if (signal?.aborted) {
        throw new ImageExecutorError({ code: IMAGE_EXECUTOR_REFUSALS.ABORTED, detail: '执行前已被中止' })
      }
      const format = input.format ?? 'png'
      const color = input.color ?? '0x1F6FEB'
      await mkdir(dirname(input.outPath), { recursive: true })

      const args = ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${input.width}x${input.height}`, '-frames:v', '1', input.outPath]
      let result: SpawnResult
      try {
        result = await spawn(ffmpeg, args, { timeoutMs, ...(signal === undefined ? {} : { signal }) })
      } catch (error) {
        const err = error as Error & { code?: string }
        throw new ImageExecutorError({
          code: err.code === 'ENOENT' ? IMAGE_EXECUTOR_REFUSALS.DEPENDENCY_MISSING : IMAGE_EXECUTOR_REFUSALS.RUN_FAILED,
          detail: `${ffmpeg} 未能启动：${err.message}`,
        })
      }
      if (result.error?.code === 'ENOENT') {
        // 依赖不在 ⇒ 明确失败。**绝不退回占位图。**
        throw new ImageExecutorError({ code: IMAGE_EXECUTOR_REFUSALS.DEPENDENCY_MISSING, detail: `${ffmpeg} 不在 PATH 里` })
      }
      if (result.error?.code === 'ETIMEDOUT') {
        throw new ImageExecutorError({ code: IMAGE_EXECUTOR_REFUSALS.TIMEOUT, detail: `超过 ${timeoutMs}ms` })
      }
      if (result.code !== 0) {
        throw new ImageExecutorError({
          code: IMAGE_EXECUTOR_REFUSALS.RUN_FAILED,
          detail: `${ffmpeg} 退出码 ${String(result.code)}：${(result.stderr || result.stdout).trim().split('\n').slice(-1)[0]?.slice(0, 200) ?? ''}`,
        })
      }

      // 产物必须真的存在且非空 —— "命令返回 0"不等于"图写出来了"。
      let bytes: number
      let sha256: string
      try {
        const info = await stat(input.outPath)
        bytes = info.size
        if (bytes <= 0) throw new ImageExecutorError({ code: IMAGE_EXECUTOR_REFUSALS.EMPTY_ARTIFACT, detail: '产物字节数为 0' })
        const buf = await readFile(input.outPath)
        sha256 = createHash('sha256').update(buf).digest('hex')
      } catch (error) {
        if (error instanceof ImageExecutorError) throw error
        throw new ImageExecutorError({ code: IMAGE_EXECUTOR_REFUSALS.EMPTY_ARTIFACT, detail: `产物读不到：${(error as Error).message}` })
      }

      const noteText = input.prompt ? `按任务文字要求产出（文字仅留档，不解析）：${input.prompt.slice(0, 80)}` : null
      return {
        artifactPath: input.outPath,
        format,
        width: input.width,
        height: input.height,
        bytes,
        sha256,
        // prompt 只留档，不参与执行 —— 任务文本是**不可信输入**。
        // 没有 note 时**不设这个键**（`exactOptionalPropertyTypes` 不许显式 undefined）。
        ...(noteText === null ? {} : { note: noteText }),
      }
    },
  }
}
