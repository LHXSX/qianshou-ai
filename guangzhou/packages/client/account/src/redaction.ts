/**
 * 口令与令牌的遮盖工具。
 *
 * 为什么必须有这一层：本包的失败对象会进入日志、错误上报和界面提示。上游的校验错误
 * 会把**提交过的请求体原样回显**——实测 `POST /auth/register` 的 422 响应里
 * `errors[0].input` 就是提交的 `password`。任何「把上游 message 直接显示/记录」的写法
 * 都会把用户口令写进日志。
 *
 * 因此本包遵守两条规则：
 * 1. 上游的错误数组**整体丢弃**，只留下本包自己写的中文字段提示；
 * 2. 任何最终进入失败对象或诊断记录的文本，都要再经过一次 `redactText` 遮盖。
 *
 * 遮盖是第二道防线，不是唯一防线：即使将来有人把原始响应接到别处，口令也不会以明文
 * 形式出现在本包产出的字符串里。
 */

/** 遮盖后替换成的字样。用固定标记而不是空串，便于排查时看出「这里原本有内容」。 */
export const REDACTED = '[已遮盖]'

/**
 * 从文本里删掉每一个敏感值。
 *
 * 用 `split/join` 而不是正则：口令里可能含正则元字符，转义一旦漏掉就会遮不干净，
 * 而「遮不干净」正是这里最不能接受的失败方式。
 * 先长后短替换，避免短值命中长值的片段后留下残尾。
 * @param text - 原始文本。
 * @param secrets - 不得出现在文本里的明文值；空值自动忽略。
 * @returns 遮盖后的文本。
 */
export function redactText(text: string, secrets: readonly (string | null | undefined)[]): string {
  const present = secrets
    .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0)
    .sort((left, right) => right.length - left.length)
  let out = text
  for (const secret of present) out = out.split(secret).join(REDACTED)
  return out
}

/**
 * 上游 message 里出现这些字样时，一律替换成中性说明。
 *
 * 上游偶尔会把「请求参数校验失败」写成带字段值的句子；直接展示它等于把提交内容带上屏。
 */
const ECHO_PATTERNS: readonly RegExp[] = [
  /input['"]?\s*[:=]\s*[^\s,}]+/giu,
]

/** 去掉上游 message 里回显的字段值。 */
export function stripEchoes(message: string): string {
  let out = message
  for (const pattern of ECHO_PATTERNS) out = out.replace(pattern, '')
  return out.trim()
}
