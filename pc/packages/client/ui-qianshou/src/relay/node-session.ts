/**
 * 节点启动要用的两件非秘密事实：仓库在哪、机主 id 是多少。
 * 访问凭据本身不在这里保存；调用方只把令牌字符串交进来做一次读取。
 */

/**
 * 从访问凭据的 JWT 载荷读机主 id。过期、不是 JWT、或 `sub` 不是正整数时返回 `null`。
 * @param token - 已保存的访问凭据。
 * @param nowMs - 当前时刻（毫秒）。
 * @returns 机主 id，或 `null`。
 */
export function ownerIdFromAccessToken(token: string, nowMs: number): number | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const payload = parts[1]
  if (payload === undefined || payload === '') return null
  let record: { sub?: unknown, exp?: unknown }
  try {
    record = JSON.parse(decodeBase64Url(payload)) as { sub?: unknown, exp?: unknown }
  } catch {
    // 载荷不是 JSON 时，这枚凭据不能用来填 `--owner`。
    return null
  }
  if (typeof record.exp === 'number' && record.exp * 1000 <= nowMs) return null
  if (typeof record.sub !== 'string' || !/^[1-9]\d*$/.test(record.sub)) return null
  const ownerId = Number(record.sub)
  return Number.isSafeInteger(ownerId) ? ownerId : null
}

/**
 * 找到带 `apps/qianshou-node/node-daemon.mts` 的仓库根。
 * 先看 `QIANSHOU_NODE_REPO`，再从起点往上走。
 * @param exists - 文件是否存在。
 * @param envRepo - 环境变量里的仓库路径；空表示没设。
 * @param start - 往上找的起点（通常是宿主入口所在目录）。
 * @returns 仓库根，找不到是 `null`。
 */
export function findNodeRepo(exists: (path: string) => boolean, envRepo: string | undefined, start: string): string | null {
  if (envRepo !== undefined && envRepo !== '' && exists(daemonFile(envRepo))) return envRepo
  let dir = start
  for (let depth = 0; depth < 8; depth += 1) {
    if (exists(daemonFile(dir))) return dir
    const slash = dir.lastIndexOf('/')
    if (slash <= 0) return null
    dir = dir.slice(0, slash)
  }
  return null
}

function daemonFile(repo: string): string {
  return `${repo}/apps/qianshou-node/node-daemon.mts`
}

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
