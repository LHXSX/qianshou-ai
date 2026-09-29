/**
 * IP 白名单：管理台的第一道门。
 *
 * 三条设计决定，都是被"默认放行"这类事故逼出来的：
 *
 * 1. **默认拒绝**。白名单为空 = 谁都不许进（回环除外），而不是"没配置就全放"。
 *    配置解析失败也一样拒绝：一份读不出来的白名单不能被当成"没有限制"。
 * 2. **回环永远放行**（逃生路径）。否则一旦把自己的 IP 写错，管理台就彻底进不去，
 *    只能停机改文件。回环放行意味着：任何能在服务器上执行命令的人，
 *    都可以 `curl 127.0.0.1:7090` 或跑 CLI 把自己加回来——而这正是运维的正常路径。
 *    放行的代价是零：能连本机回环的进程本来就有这台机器的权限。
 * 3. **白名单只管来源，不当授权**。它和 RBAC 是两层，都在服务端：
 *    白名单决定"你能不能敲到门"，角色决定"进门之后能做什么"。
 */
import { cidrContains, isLoopback, parseCidr } from './cidr.ts'

/** 一条白名单条目。 */
export interface WhitelistEntry {
  /** CIDR 或裸地址。 */
  readonly cidr: string
  /** 备注（谁的出口、哪个办公网）。 */
  readonly note: string
  /** 谁加的（管理员 accountId；CLI 加的写 `cli`）。 */
  readonly addedBy: string
  /** 何时加的（毫秒）。 */
  readonly addedAt: number
}

/** 白名单配置。 */
export interface WhitelistConfig {
  /**
   * 是否启用白名单。
   *
   * `true`（默认）= 默认拒绝一切；`false` = 允许所有来源（**只能由 CLI 关闭**，
   * 供灾难恢复用，关闭本身会被审计）。接口层面不提供关闭开关：
   * 「把自己家的门全打开」不该是一个点两下就能完成的动作。
   */
  readonly enabled: boolean
  readonly entries: readonly WhitelistEntry[]
}

/** 判定结果。 */
export interface WhitelistDecision {
  readonly allowed: boolean
  /** 机器可读原因：`loopback` | `match:<cidr>` | `empty` | `disabled` | `no-match` | `malformed`。 */
  readonly reason: string
  /** 命中的条目（如果有）。 */
  readonly matched: string | null
}

/** 空白名单（默认值）。 */
export function emptyWhitelist(): WhitelistConfig {
  return { enabled: true, entries: [] }
}

/** 校验一条待添加的规则是否为合法 CIDR/地址。 */
export function isValidRule(cidr: string): boolean {
  return parseCidr(cidr) !== null
}

/**
 * 判定一个来源地址是否放行。
 * @param ip - 来源地址（`resolveClientAddress` 的结果）。
 * @param config - 白名单配置。
 * @returns 判定结果（拒绝时也给出原因，审计里要能解释为什么被拒）。
 */
export function decideWhitelist(ip: string, config: WhitelistConfig): WhitelistDecision {
  // 逃生路径优先于一切配置：回环永远放行，即使白名单为空或解析失败。
  if (ip.length > 0 && isLoopback(ip)) {
    return { allowed: true, reason: 'loopback', matched: null }
  }
  if (!config.enabled) {
    return { allowed: true, reason: 'disabled', matched: null }
  }
  if (config.entries.length === 0) {
    return { allowed: false, reason: 'empty', matched: null }
  }
  for (const entry of config.entries) {
    if (!isValidRule(entry.cidr)) continue
    if (cidrContains(ip, entry.cidr)) {
      return { allowed: true, reason: `match:${entry.cidr}`, matched: entry.cidr }
    }
  }
  return { allowed: false, reason: 'no-match', matched: null }
}
