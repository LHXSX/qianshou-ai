/**
 * 入口：`serve` 起服务，其余子命令做**只能在服务器上做的事**。
 *
 * 为什么 CLI 必须存在（而不是"什么都从这个管理台界面里点"）：
 * 白名单为空时管理台默认拒绝一切，界面本身打不开——这时能救场的只有
 * "在服务器上执行命令"这条路径。它同时是第一个管理员的创建入口：
 * 授权之前没有管理员能登录，没有管理员就没人能在界面里授权。
 *
 * 用法：
 * ```
 * node src/main.ts serve
 * node src/main.ts whitelist add 203.0.113.7/32 --note 办公出口
 * node src/main.ts whitelist list
 * node src/main.ts admin grant 167 --role super-admin --name 张三
 * node src/main.ts admin list
 * ```
 */
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { BUILTIN_ROLES, findRole, roleGrantable, type AdminRecord } from './rbac.ts'
import { isValidRule } from './whitelist.ts'
import { createAdminService, type AdminConfig } from './server.ts'

/** 环境变量读取（空字符串按未设置处理）。 */
function env(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value.length === 0 ? undefined : value
}

/**
 * 从环境变量组装配置。
 *
 * 默认值刻意指向**部署形状**（广州服务器上的绝对路径），因为这台服务的运行环境
 * 就是它；本地开发用环境变量覆盖即可。写死"当前目录"会让一个从别处启动的进程
 * 悄悄读到空数据目录，然后"表现得像没人被授权"——那种故障最难查。
 */
export function configFromEnv(): AdminConfig {
  const workbenchBaseUrl = env('QIANSHOU_ADMIN_WORKBENCH_BASE_URL')
  const apiConnectionsBaseUrl = env('QIANSHOU_ADMIN_API_CONNECTIONS_BASE_URL')
  return {
    apiConnectionsPlatform: {
      ...(env('QIANSHOU_ADMIN_API_CONNECTIONS_PUBLIC_BASE_URL') === undefined ? {} : { publicBaseUrl: env('QIANSHOU_ADMIN_API_CONNECTIONS_PUBLIC_BASE_URL') as string }),
      ...(env('QIANSHOU_ADMIN_API_CONNECTIONS_PROBE_TIMEOUT_MS') === undefined ? {} : { probeTimeoutMs: Number(env('QIANSHOU_ADMIN_API_CONNECTIONS_PROBE_TIMEOUT_MS')) }),
    },
    ...(apiConnectionsBaseUrl === undefined ? {} : { apiConnections: {
      baseUrl: apiConnectionsBaseUrl,
      keyId: env('QIANSHOU_ADMIN_API_CONNECTIONS_KEY_ID') ?? '',
      credentialRef: env('QIANSHOU_ADMIN_API_CONNECTIONS_KEY_REF') ?? '',
      audience: env('QIANSHOU_ADMIN_API_CONNECTIONS_AUDIENCE') ?? '',
    } }),
    ...(workbenchBaseUrl === undefined ? {} : { workbench: {
      baseUrl: workbenchBaseUrl,
      keyId: env('QIANSHOU_ADMIN_WORKBENCH_KEY_ID') ?? '',
      credentialRef: env('QIANSHOU_ADMIN_WORKBENCH_KEY_REF') ?? '',
      audience: env('QIANSHOU_ADMIN_WORKBENCH_AUDIENCE') ?? '',
    } }),
    dataDir: env('QIANSHOU_ADMIN_DATA_DIR') ?? '/srv/qianshou-admin/data',
    webRoot: env('QIANSHOU_ADMIN_WEB_ROOT') ?? '/srv/qianshou-admin/web',
    origin: env('QIANSHOU_ADMIN_ORIGIN') ?? 'https://admin.qianshousuanli.com',
    accountBaseUrl: env('QIANSHOU_ADMIN_ACCOUNT_BASE_URL') ?? 'https://qianshousuanli.com',
    ...(env('QIANSHOU_ADMIN_ACCOUNT_PREFIX') === undefined ? {} : { accountPrefix: env('QIANSHOU_ADMIN_ACCOUNT_PREFIX') as string }),
    dshHome: env('QIANSHOU_ADMIN_DSH_HOME') ?? '/srv/qianshou-home',
    tiersPath: env('QIANSHOU_ADMIN_TIERS_PATH') ?? '/srv/qianshou-agent/packages/host/model-gateway/src/tiers.ts',
    trustProxy: env('QIANSHOU_ADMIN_TRUST_PROXY') !== '0',
    ...(env('QIANSHOU_ADMIN_SESSION_TTL_MS') === undefined ? {} : { sessionTtlMs: Number(env('QIANSHOU_ADMIN_SESSION_TTL_MS')) }),
    ...(env('QIANSHOU_ADMIN_VERIFY_INTERVAL_MS') === undefined ? {} : { verifyIntervalMs: Number(env('QIANSHOU_ADMIN_VERIFY_INTERVAL_MS')) }),
  }
}

/** 取 `--flag value` 形式的参数。 */
function flagOf(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return undefined
  return args[index + 1]
}

/** 打印并退出。 */
function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/**
 * 子命令实现。
 * @param args - 去掉 node 与脚本名之后的参数。
 * @returns 退出码。
 */
export async function runCli(args: readonly string[]): Promise<number> {
  const [command = 'serve', ...rest] = args
  const config = configFromEnv()
  const service = createAdminService(config)

  switch (command) {
    case 'serve': {
      const host = env('QIANSHOU_ADMIN_HOST') ?? '127.0.0.1'
      const port = Number(env('QIANSHOU_ADMIN_PORT') ?? '7090')
      await mkdir(config.dataDir, { recursive: true })
      const server = createServer((request, response) => {
        void service.handle(request, response)
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => { resolve() })
      })
      const whitelist = await service.components.whitelist.load()
      process.stdout.write(
        `[admin-console] 监听 http://${host}:${port}（origin=${config.origin}）\n`
        + `[admin-console] 数据目录 ${config.dataDir}｜前端产物 ${config.webRoot}\n`
        + `[admin-console] 白名单：${whitelist.enabled ? '启用' : '已关闭'}，${whitelist.entries.length} 条；回环永远放行\n`,
      )
      return 0
    }

    case 'init': {
      await mkdir(config.dataDir, { recursive: true })
      await service.components.admins.load()
      await service.components.roles.load()
      await service.components.whitelist.load()
      await service.components.flags.load()
      process.stdout.write(`[admin-console] 数据目录已初始化：${config.dataDir}\n`)
      return 0
    }

    case 'whitelist': {
      const sub = rest[0]
      const file = await service.components.whitelist.load()
      if (sub === 'list' || sub === undefined) {
        process.stdout.write(`启用：${file.enabled}；条目 ${file.entries.length} 条\n`)
        for (const entry of file.entries) {
          process.stdout.write(`  ${entry.cidr}  ${entry.note}  (by ${entry.addedBy} @ ${new Date(entry.addedAt).toISOString()})\n`)
        }
        if (file.entries.length === 0) process.stdout.write('（为空 = 只允许本机回环访问）\n')
        return 0
      }
      if (sub === 'add') {
        const cidr = rest[1] ?? flagOf(rest, 'cidr')
        if (cidr === undefined) fail('用法：whitelist add <IP 或 CIDR> [--note 说明]')
        if (!isValidRule(cidr)) fail(`不是合法的 IP 或 CIDR：${cidr}`)
        const note = flagOf(rest, 'note') ?? ''
        const entries = file.entries.some(entry => entry.cidr === cidr)
          ? file.entries
          : [...file.entries, { cidr, note, addedBy: 'cli', addedAt: Date.now() }]
        await service.components.whitelist.save({ version: 1, enabled: file.enabled, entries })
        process.stdout.write(`已加入白名单：${cidr}（现在 ${entries.length} 条）\n`)
        return 0
      }
      if (sub === 'remove') {
        const cidr = rest[1]
        if (cidr === undefined) fail('用法：whitelist remove <IP 或 CIDR>')
        const entries = file.entries.filter(entry => entry.cidr !== cidr)
        if (entries.length === file.entries.length) fail(`白名单里没有这一条：${cidr}`)
        await service.components.whitelist.save({ version: 1, enabled: file.enabled, entries })
        process.stdout.write(`已移出白名单：${cidr}（现在 ${entries.length} 条）\n`)
        return 0
      }
      if (sub === 'enable' || sub === 'disable') {
        await service.components.whitelist.save({ version: 1, enabled: sub === 'enable', entries: file.entries })
        process.stdout.write(`白名单已${sub === 'enable' ? '启用（默认拒绝）' : '关闭（允许所有来源，仅用于灾难恢复）'}\n`)
        return 0
      }
      fail('whitelist 子命令：list | add | remove | enable | disable')
      return 1
    }

    case 'admin': {
      const sub = rest[0]
      const accountId = rest[1] ?? flagOf(rest, 'account')
      const file = await service.components.admins.load()
      if (sub === 'list' || sub === undefined) {
        if (file.admins.length === 0) process.stdout.write('（还没有任何管理员；用 admin grant 添加第一个）\n')
        for (const admin of file.admins) {
          process.stdout.write(`  ${admin.accountId}  ${admin.roleId}  scope=${admin.scope}  ${admin.enabled ? '启用' : '停用'}  ${admin.displayName}\n`)
        }
        return 0
      }
      if (accountId === undefined) fail(`用法：admin ${sub} <accountId> [--role super-admin] [--scope all|self] [--name 展示名]`)
      if (sub === 'grant') {
        const roleId = flagOf(rest, 'role') ?? 'super-admin'
        const roles = await service.components.roles.load()
        const role = findRole(roles.roles, roleId)
        const problem = roleGrantable(role)
        if (problem !== null) fail(problem)
        const scope = flagOf(rest, 'scope') === 'self' ? 'self' : 'all'
        const record: AdminRecord = {
          accountId,
          displayName: flagOf(rest, 'name') ?? accountId,
          roleId,
          scope,
          enabled: true,
          createdAt: Date.now(),
          createdBy: 'cli',
        }
        const next = [...file.admins.filter(admin => admin.accountId !== accountId), record]
        await service.components.admins.save({ version: 1, admins: next })
        process.stdout.write(`已授予 ${accountId} → ${roleId}（scope=${scope}）\n`)
        return 0
      }
      if (sub === 'revoke') {
        const next = file.admins.filter(admin => admin.accountId !== accountId)
        if (next.length === file.admins.length) fail(`这个账号不是管理员：${accountId}`)
        await service.components.admins.save({ version: 1, admins: next })
        process.stdout.write(`已撤销 ${accountId} 的管理员资格\n`)
        return 0
      }
      if (sub === 'enable' || sub === 'disable') {
        const exists = file.admins.some(admin => admin.accountId === accountId)
        if (!exists) fail(`这个账号不是管理员：${accountId}`)
        const next = file.admins.map(admin =>
          admin.accountId === accountId ? { ...admin, enabled: sub === 'enable' } : admin)
        await service.components.admins.save({ version: 1, admins: next })
        process.stdout.write(`已${sub === 'enable' ? '启用' : '停用'} ${accountId}\n`)
        return 0
      }
      fail('admin 子命令：list | grant | revoke | enable | disable')
      return 1
    }

    case 'roles': {
      const sub = rest[0]
      if (sub !== 'list' && sub !== undefined) fail('roles 子命令：list')
      const roles = await service.components.roles.load()
      process.stdout.write('内置角色：\n')
      for (const role of BUILTIN_ROLES) {
        process.stdout.write(`  ${role.id}  ${role.name}  ${role.permissions.length} 个权限  scope=${role.scopeDefault}\n`)
      }
      process.stdout.write(`自定义角色：${roles.roles.length} 个\n`)
      for (const role of roles.roles) process.stdout.write(`  ${role.id}  ${role.name}  ${role.permissions.length} 个权限\n`)
      return 0
    }

    default:
      fail(`不认识的子命令：${command}。可用：serve | init | whitelist | admin | roles`)
      return 1
  }
}

// 直接执行时才跑（被测试 import 时不跑）。
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((error: unknown) => {
    process.stderr.write(`[admin-console] 启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
