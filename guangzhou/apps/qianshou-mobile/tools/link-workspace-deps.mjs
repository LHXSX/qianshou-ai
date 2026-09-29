/**
 * 幂等地补齐 `apps/qianshou-mobile/node_modules` 里的工作区链接。
 *
 * 为什么需要它：这个 app 的依赖在 `package.json` 里**声明正确**，但 pnpm 不会
 * 物化它的 `node_modules`——实测过两次（删掉已声明的链接后 `pnpm install` 说
 * "Already up to date" 且不重建，加 `--filter` 也一样）。于是测试会因为
 * `Failed to resolve import "@deepseek-ai/dsh-client-account"` 而红，
 * 而根因在环境而不是代码，排查成本很高——这个脚本就是为了让那次排查不再发生。
 *
 * 它**只补缺失的链接**，不覆盖已存在的；不改任何被跟踪的文件。
 * 跑法：`node apps/qianshou-mobile/tools/link-workspace-deps.mjs`
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const repoRoot = join(appDir, '..', '..')
const manifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))

/** 所有以 `workspace:` 声明的依赖，都要有一条指向仓库内对应包的链接。 */
const workspaceDeps = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
  .filter(([, spec]) => String(spec).startsWith('workspace:'))
  .map(([name]) => name)

/**
 * 在仓库里按 `package.json` 的 `name` **精确查找**工作区包的真实目录。
 *
 * 不按包名推断路径：`dsh-client-pc-window-bridge` 这种连字符名会被推成
 * `packages/window/bridge`（错的）。扫目录读 name 是唯一可靠的做法。
 * @param wanted - 要找的包名。
 * @returns 仓库内的绝对目录；找不到返回 `undefined`。
 */
function findWorkspaceDir(wanted) {
  const stack = ['packages', 'apps', 'vendor', 'native'].map(root => join(repoRoot, root))
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const child = join(dir, entry.name)
      const manifestPath = join(child, 'package.json')
      if (existsSync(manifestPath)) {
        try {
          if (JSON.parse(readFileSync(manifestPath, 'utf8')).name === wanted) return child
        } catch { /* 读不动的 manifest 就跳过 */ }
      }
      stack.push(child)
    }
  }
  return undefined
}

const modulesDir = join(appDir, 'node_modules')
let created = 0
let present = 0
const missing = []

for (const name of workspaceDeps) {
  const linkPath = join(modulesDir, name)
  if (existsSync(linkPath)) { present += 1; continue }
  const target = findWorkspaceDir(name)
  if (target === undefined) { missing.push(name); continue }
  mkdirSync(dirname(linkPath), { recursive: true })
  // 相对路径：仓库整体移动后链接仍然有效。
  symlinkSync(relative(dirname(linkPath), target), linkPath)
  created += 1
}

console.log(`工作区依赖 ${workspaceDeps.length} 个：已在位 ${present} 个，本次补建 ${created} 个`)
if (missing.length > 0) {
  console.error(`以下依赖在仓库里找不到对应目录，请手工确认：${missing.join(', ')}`)
  process.exitCode = 1
}
