/**
 * 客户端产物校验：防止"代码改了界面对不上"和"千手皮肤被编译掉"这两类静默故障。
 *
 * ## 它防的两件事（都真实发生过，各不止一次）
 *
 * 1. **产物落后于源码**。`pre-push` 只跑 `build:lib:host`，客户端产物在
 *    `build:lib:client` 里——**从不被推送重建**。于是代码改了、界面不变，
 *    使用者会以为"界面回退了"，而实际上产物还是几天前那一份。
 *    实测过一次：`ui-chat` 有 **174 个源文件**比它的产物新。
 *
 * 2. **皮肤被编译掉**。forge 门面要求编译期环境变量
 *    `DSH_CLIENT_BUILD_PROFILE=forge`；而 `DSH_BUILD_CLIENT_PROFILE` 是**选择器**
 *    且只接受 `official`（传 `forge` 会抛错）。谁不带变量跑一次 `build:lib:client`，
 *    品牌就退成「DSH 本地构建」、千手那批导航项整批消失——**构建成功、零报错**。
 *
 * 两类故障的共同点是最坏的那种：**没有错误信息**，只有界面悄悄变了。
 * 所以这里做的是把它们变成一次响亮的失败。
 *
 * ## 判据为什么这么选
 *
 * - 落后判据用 **mtime** 而不是内容哈希：哈希更准，但要把每个源文件读一遍，
 *   而这个脚本每次推送都跑。mtime 的伪阴性（源码被碰过但内容没变）只会让人
 *   多跑一次构建，代价可接受；伪阳性（内容变了 mtime 没变）在实践中不存在。
 * - 皮肤判据**只查一个包的产物文本**：`ui-brand-official` 是千手门面的唯一入口，
 *   它里面有没有 forge 文案就等价于"这次构建用的是哪个 profile"。
 *   不查 `data-qianshou-product` 之类运行时属性——那是 DOM 的事，不该在这里断言。
 *
 * 用法：
 *   node_modules/.bin/tsx scripts/verify-client-artifacts.ts          # 校验
 *   node_modules/.bin/tsx scripts/verify-client-artifacts.ts --fix    # 只打印修复命令
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（本文件在 `scripts/` 下）。 */
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 千手门面所在的包；皮肤判据只看它。 */
const BRAND_PACKAGE = 'packages/client/ui-brand-official'

/** 只在千手门面产物里出现的文案。 */
const FORGE_MARKERS = ['一群AI，为你而来'] as const

/** 重建客户端产物的正确命令（必须带编译期 profile）。 */
/**
 * 重建命令。
 *
 * 千手皮肤**现在是构建默认值**（见 `client-build-environment.ts` 的
 * `QIANSHOU_CLIENT_BUILD_ENVIRONMENT`），所以这里不再需要显式带变量——
 * 少一个"必须记得"的点，就少一类反复发生的错误。
 * 显式带上也仍然有效（显式优先）。
 */
export const REBUILD_COMMAND = 'npm run build:lib:client'

/** 一处发现。 */
export interface Finding {
  /** 分类：产物落后、皮肤不对、产物缺失。 */
  readonly kind: 'stale' | 'skin' | 'missing'
  /** 出问题的路径（相对仓库根）。 */
  readonly path: string
  /** 人话说明。 */
  readonly detail: string
}

/** 收集 `packages/<a>/<b>` 这一层的目录名。 */
function packageDirs(): string[] {
  const out: string[] = []
  const groups = join(ROOT, 'packages')
  if (!existsSync(groups)) return out
  for (const group of readdirSync(groups)) {
    const groupPath = join(groups, group)
    if (!statSync(groupPath).isDirectory()) continue
    for (const name of readdirSync(groupPath)) {
      const rel = join('packages', group, name)
      if (existsSync(join(ROOT, rel, 'package.json'))) out.push(rel)
    }
  }
  return out
}

/** 递归收集某目录下所有会进入产物的源文件。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      const info = statSync(full)
      if (info.isDirectory()) { walk(full); continue }
      if (/\.(ts|tsx|css)$/u.test(entry)) out.push(full)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

/**
 * 跑一次校验。
 * @returns 发现清单；空数组表示一切正常。
 */
export function verifyClientArtifacts(): Finding[] {
  const findings: Finding[] = []
  for (const rel of packageDirs()) {
    const artifact = join(ROOT, rel, 'lib', 'client.js')
    if (!existsSync(artifact)) continue // 这个包没有客户端面，跳过。
    const artifactTime = statSync(artifact).mtimeMs
    const newer = sourceFiles(join(ROOT, rel, 'src')).filter(file => statSync(file).mtimeMs > artifactTime)
    if (newer.length > 0) {
      findings.push({
        kind: 'stale',
        path: `${rel}/lib/client.js`,
        detail: `${newer.length} 个源文件比产物新（例如 ${newer[0]?.replace(`${ROOT}/`, '') ?? '?'}）——界面不会反映这些改动`,
      })
    }
  }

  // 皮肤：只查千手门面那一个产物。
  const brandArtifact = join(ROOT, BRAND_PACKAGE, 'lib', 'client.js')
  if (!existsSync(brandArtifact)) {
    findings.push({ kind: 'missing', path: `${BRAND_PACKAGE}/lib/client.js`, detail: '千手门面产物不存在' })
  } else {
    const text = readFileSync(brandArtifact, 'utf8')
    const missing = FORGE_MARKERS.filter(marker => !text.includes(marker))
    if (missing.length > 0) {
      findings.push({
        kind: 'skin',
        path: `${BRAND_PACKAGE}/lib/client.js`,
        detail: `产物里没有千手门面文案（缺 ${missing.join('、')}）——这次构建没带 DSH_CLIENT_BUILD_PROFILE=forge`,
      })
    }
    /**
     * **死分支检查**：查 `DSH_CLIENT_BUILD_PROFILE` 这个符号本身是否还在产物里。
     *
     * ## 为什么"文案在"不足以证明皮肤生效
     *
     * 构建会把 `process.env` 替换成 `{}`，并且**只为环境里已存在的变量**生成逐项 define。
     * 于是环境里没有 `DSH_CLIENT_BUILD_PROFILE` 时，源码
     * `process.env.DSH_CLIENT_BUILD_PROFILE === 'forge'` 被编译成
     * `{}.DSH_CLIENT_BUILD_PROFILE === "forge"` —— **恒为 undefined，分支永不执行**。
     *
     * 而该条件**无法静态求值**，所以千手的字符串**不会被 tree-shake**：
     * 产物里看得见「一群AI，为你而来」，界面却是默认皮肤。
     * 只查字符串的门禁在这一状态下**照样通过**——这正是它曾漏掉这个 bug 的原因
     * （用户为此反馈过三次，团队误判过三轮）。
     *
     * ## 反向判据
     *
     * profile 正确内联时，条件会被**静态求值消除**，整个符号从产物里消失。
     * 所以：**产物里还能看到这个符号 = define 没内联 = 存在死分支风险**。
     */
    if (text.includes('DSH_CLIENT_BUILD_PROFILE')) {
      findings.push({
        kind: 'skin',
        path: `${BRAND_PACKAGE}/lib/client.js`,
        detail: '产物里仍有 DSH_CLIENT_BUILD_PROFILE 比较——define 未静态求值（会编译成 `{}.… === "forge"` 恒假），'
          + '界面会静默退回默认皮肤。修：用 `npm run build:lib:client` 重建（脚本已默认千手皮肤）',
      })
    }
  }
  return findings
}

/* 直接执行时才打印并决定退出码；被 import 时不产生副作用。 */
const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')
if (invokedDirectly) {
  const findings = verifyClientArtifacts()
  if (findings.length === 0) {
    console.log('verify-client-artifacts: 客户端产物与源码同步，且千手门面在位')
  } else {
    console.error('verify-client-artifacts: 客户端产物不可用（界面会与源码不一致）')
    for (const f of findings) console.error(`  [${f.kind}] ${f.path}: ${f.detail}`)
    console.error(`\n修好它：${REBUILD_COMMAND}`)
    console.error('（宿主侧改动必须跑 `npm run build:lib:host`：它含 `tsc -b tsconfig.host.json`，只跑 `tsdown` 不拾取 `src/` 改动。）')
    process.exitCode = 1
  }
}
