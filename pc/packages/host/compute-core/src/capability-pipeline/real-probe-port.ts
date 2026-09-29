/**
 * 真实探测端口（A 工单）：把"装了"变成"真的调用过一次"。
 *
 * 这是能力声明管线里**唯一需要真实执行外部进程**的缝（见 types.ts 头注释）。
 * 设计要点（每一条都对应本仓库踩过的坑）：
 *
 * 1. **"文件在 / 命令在 PATH / 版本号可读"一律不算调用过** —— `invoked` 的定义就是"真的起过进程"。
 *    （真实事故：`native_bins` 错名活两个月，两侧测试全绿，就是因为没人真的去调用过。）
 * 2. **不认识的能力 ⇒ 明确拒绝，绝不猜**：没有调用配方时返回 `invoked:false` + `PROBE_NO_INVOCATION_RECIPE`，
 *    而不是"东西在就算健康"。（对应铁律：静默即缺陷 —— 这里改为"明确说不知道"。）
 * 3. **不用 shell**：`execFile` + argv 数组，杜绝命令拼接注入。
 * 4. **超时有界**：探测不许挂死节点；默认 5s，可注入。
 * 5. **能跑但打折 ⇒ `degraded`**：例如退出码 0 却拿不到版本行；`degraded` **同样不进候选池**。
 *
 * 测试无法跑真 ffmpeg，所以外部执行被收敛成一个可注入的 `ProbeSpawn`，
 * 判定规则本身可以在不跑任何进程的前提下被钉住（先红后绿）。
 */

import { execFile } from 'node:child_process'

import type { CapabilityHealthFailureReason, CapabilityProbeOutcome, CapabilityProbePort } from './types.ts'

/** 本模块自己产出的原因码（与 types.ts 的管线码区分开，便于归因） */
export const PROBE_FAILURE_REASONS = Object.freeze({
  /** 没有调用配方：不知道该怎么"真的调用一次"这项能力 ⇒ 明确拒绝，不许当成健康。 */
  NO_INVOCATION_RECIPE: 'PROBE_NO_INVOCATION_RECIPE',
  /** 进程起来了但退出码非零。 */
  EXIT_NONZERO: 'PROBE_EXIT_NONZERO',
  /** 进程都没起来（ENOENT / 权限 / 超时 / 被中止）。 */
  SPAWN_FAILED: 'PROBE_SPAWN_FAILED',
  /** 超时。 */
  TIMED_OUT: 'PROBE_TIMED_OUT',
  /** 被中止（主人叫停 / 上层取消）。 */
  ABORTED: 'PROBE_ABORTED',
} as const) satisfies Record<string, CapabilityHealthFailureReason>

/** 一次真实外部调用的结果。 */
export interface ProbeSpawnResult {
  /** 退出码；进程没起来时为 `null`。 */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** 进程没起来时带上错误（ENOENT 等）。 */
  readonly error?: Error & { code?: string }
}

/** 可注入的外部执行缝（测试用假实现，真机用 `execFile`）。 */
export type ProbeSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<ProbeSpawnResult>

/** 一项能力的"最小真实调用"配方。 */
export interface ProbeRecipe {
  readonly command: string
  readonly args: readonly string[]
  /** 从输出里认出"这是它的版本行"；认不出 ⇒ `degraded`。 */
  readonly recognizes?: (stdout: string) => boolean
  /** 主人可读的说明（写进 detail，便于追问"它到底调了什么"）。 */
  readonly note?: string
}

/**
 * 默认配方：全部是"问版本"这种**无副作用**的最小真实调用。
 * 新增一项能力 = 在这里加一条配方；**没有配方就诚实地报"不知道该怎么调"**。
 */
export const DEFAULT_PROBE_RECIPES: Readonly<Record<string, ProbeRecipe>> = Object.freeze({
  ffmpeg: { command: 'ffmpeg', args: ['-version'], recognizes: line => /^ffmpeg version/i.test(line) },
  ffprobe: { command: 'ffprobe', args: ['-version'], recognizes: line => /^ffprobe version/i.test(line) },
  node: { command: 'node', args: ['--version'], recognizes: line => /^v\d+\./.test(line) },
  git: { command: 'git', args: ['--version'], recognizes: line => /^git version/i.test(line) },
  python3: { command: 'python3', args: ['--version'], recognizes: line => /^Python \d+\./i.test(line) },
})

export interface RealProbePortOptions {
  /** 覆盖外部执行（测试注入假 spawn）。 */
  readonly spawn?: ProbeSpawn
  /** 单次探测的超时；默认 5s。 */
  readonly timeoutMs?: number
  /** 覆盖/追加调用配方。 */
  readonly recipes?: Readonly<Record<string, ProbeRecipe>>
}

/** 默认 spawn：`execFile` + argv 数组（不经 shell）。 */
const defaultSpawn: ProbeSpawn = (command, args, options) =>
  new Promise<ProbeSpawnResult>(resolve => {
    execFile(
      command,
      [...args],
      { timeout: options.timeoutMs, signal: options.signal, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: string | number }) | null
        if (err) {
          const code = typeof err.code === 'number' ? err.code : null
          const base = { code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
          // `exactOptionalPropertyTypes` 下不许显式传 undefined：有 error 才带上这个键。
          resolve(typeof err.code === 'string' ? { ...base, error: err as Error & { code?: string } } : base)
          return
        }
        resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })

function firstLine(text: string): string {
  return text.split(/\r?\n/).find(line => line.trim() !== '')?.trim() ?? ''
}

/** 把错误归类成原因码（超时/中止/起不来要能分开）。 */
function classifySpawnError(error: Error & { code?: string }, signal?: AbortSignal): string {
  if (signal?.aborted) return PROBE_FAILURE_REASONS.ABORTED
  if (error.code === 'ETIMEDOUT') return PROBE_FAILURE_REASONS.TIMED_OUT
  if (error.name === 'AbortError') return PROBE_FAILURE_REASONS.ABORTED
  return PROBE_FAILURE_REASONS.SPAWN_FAILED
}

/**
 * 造一个真实探测端口。**每项能力做一次最小真实调用**，拿不到确定结论就明确失败。
 */
export function createRealProbePort(options: RealProbePortOptions = {}): CapabilityProbePort {
  const spawn = options.spawn ?? defaultSpawn
  const timeoutMs = options.timeoutMs ?? 5_000
  const recipes: Record<string, ProbeRecipe> = { ...DEFAULT_PROBE_RECIPES, ...(options.recipes ?? {}) }

  return {
    async invoke(capability: string, signal?: AbortSignal): Promise<CapabilityProbeOutcome> {
      const recipe = recipes[capability]
      if (!recipe) {
        // 不认识 ⇒ 明确说不知道，**不许**退化成"文件在就算健康"。
        return {
          invoked: false,
          ok: false,
          reason: PROBE_FAILURE_REASONS.NO_INVOCATION_RECIPE,
          detail: `没有「${capability}」的最小真实调用配方，无法判定它是否可用`,
        }
      }
      if (signal?.aborted) {
        return { invoked: false, ok: false, reason: PROBE_FAILURE_REASONS.ABORTED, detail: '探测前已被中止' }
      }

      let result: ProbeSpawnResult
      try {
        result = await spawn(recipe.command, recipe.args, { timeoutMs, ...(signal === undefined ? {} : { signal }) })
      } catch (error) {
        const err = error as Error & { code?: string }
        return {
          invoked: true,
          ok: false,
          reason: classifySpawnError(err, signal),
          detail: `${recipe.command} 未能启动：${err.message}`,
        }
      }

      const line = firstLine(result.stdout) || firstLine(result.stderr)
      const label = `${recipe.command} ${recipe.args.join(' ')}`

      if (result.error) {
        return {
          invoked: true,
          ok: false,
          reason: classifySpawnError(result.error, signal),
          detail: `${label} 启动失败：${result.error.message}`,
        }
      }
      if (result.code !== 0) {
        return {
          invoked: true,
          ok: false,
          reason: PROBE_FAILURE_REASONS.EXIT_NONZERO,
          detail: `${label} 退出码 ${String(result.code)}${line ? `：${line}` : ''}`,
        }
      }
      const recognizes = recipe.recognizes
      if (recognizes && !recognizes(line)) {
        // 能跑但认不出自己 ⇒ 视为打折：**同样不进候选池**。
        return {
          invoked: true,
          ok: false,
          degraded: true,
          reason: PROBE_FAILURE_REASONS.EXIT_NONZERO,
          detail: `${label} 退出码 0，但输出不是可识别的版本行：${line || '(空)'}`,
        }
      }
      return { invoked: true, ok: true, detail: recipe.note ? `${label} · ${line} · ${recipe.note}` : `${label} · ${line}` }
    },
  }
}
