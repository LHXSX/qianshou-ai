/**
 * 落盘原语：原子 JSON 快照 + 只追加的 JSONL 日志。
 *
 * 为什么沿用宿主已有的形态（先写临时文件再 `rename`、`0600`）而不是引数据库：
 * 这套管理台的数据量以"人"为单位（几十个管理员、几万条审计），
 * 一个进程独占一个目录；SQLite 会新增依赖，而我们要求的读法很有限。
 * 真正要紧的是**写不坏**：`rename` 在同一个文件系统上是原子的，
 * 所以任何时刻磁盘上要么是旧文件、要么是新文件，不会出现半截 JSON。
 *
 * 审计用 JSONL（一行一条、只追加）而不是快照：审计的价值恰恰在"历史不可被改写"，
 * 快照形态允许"读出来改一改再写回去"，那正是我们要避免的。
 */
import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 目录与文件权限：里面有账号 id、IP、以及谁改了什么。 */
const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** 确保目录存在（含父目录），并收紧权限。 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE })
  await chmod(path, DIR_MODE).catch(() => { /* 目录可能是别人的：权限尽量收紧，失败不阻断 */ })
}

/**
 * 原子写一个 JSON 文件。
 * @param path - 目标路径。
 * @param value - 要写入的值。
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path))
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE })
  await rename(temporary, path)
}

/**
 * 读一个 JSON 文件。
 * @param path - 路径。
 * @returns 解析后的值；文件不存在或内容不是合法 JSON 时返回 `null`（**不抛**）。
 */
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

/** 带内存缓存与版本号的 JSON 存储。 */
export interface JsonStore<T> {
  /** 读当前值（懒加载一次）。 */
  readonly load: () => Promise<T>
  /**
   * 若磁盘上的文件已被**别的进程**改过就重新读一遍。
   *
   * 为什么必须有它：白名单的逃生路径就是"在服务器上用 CLI 把自己的 IP 加回去"，
   * 而 CLI 是另一个进程。如果本进程只在第一次请求时读一遍文件，那么
   * "加进白名单了但服务还当你是外人"——逃生路径等于失效（实测踩到过）。
   * 判据用 `mtime + size` 指纹：改过就读，没改就一次 `stat`，代价可以忽略。
   * @returns 当前值。
   */
  readonly refresh: () => Promise<T>
  /** 写回磁盘并推进版本号。 */
  readonly save: (next: T) => Promise<void>
  /** 当前内存值（未加载时抛错：调用方必须先 `load()`）。 */
  readonly current: () => T
  /** 版本号；每次 `save` 自增，用于乐观并发。 */
  readonly version: () => number
  /** 文件路径（审计与运维要用）。 */
  readonly path: string
}

/**
 * 建一个 JSON 存储。
 * @param options - 路径、默认值、以及**逐字段校验**函数。
 * @returns 存储句柄。
 */
export function createJsonStore<T>(options: {
  readonly path: string
  readonly defaults: () => T
  readonly validate: (raw: unknown) => T | null
}): JsonStore<T> {
  let cached: T | null = null
  let revision = 0
  /** 上次加载时文件的指纹（`mtimeMs:size`）；`null` 表示还没读过盘。 */
  let stamp: string | null = null
  /**
   * 加载中的 Promise。
   *
   * 为什么必须共享：这个进程会并发处理请求，而"第一次读"是异步的。
   * 不共享的话，同一瞬间的两个请求会各自读一次盘，然后用各自的副本互相覆盖。
   */
  let loading: Promise<T> | null = null

  /** 读文件指纹；文件不存在返回 `missing`。 */
  const fingerprint = async (): Promise<string> => {
    try {
      const info = await stat(options.path)
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return 'missing'
    }
  }

  const loadFromDisk = async (): Promise<T> => {
    const raw = await readJson(options.path)
    const parsed = raw === null ? null : options.validate(raw)
    // 读不懂的文件**按默认值处理**而不是按"内容可信"处理：默认值对白名单是"空"（=拒绝），
    // 对管理员表是"没人"（=拒绝），两者都是 fail-closed 的方向。
    cached = parsed ?? options.defaults()
    stamp = await fingerprint()
    return cached
  }

  const load = async (): Promise<T> => {
    if (cached !== null) return cached
    loading ??= loadFromDisk()
    return await loading
  }

  return {
    load,
    refresh: async () => {
      if (cached === null) return await load()
      const current = await fingerprint()
      // 文件被删掉或读不到：保留当前内存值（不要把"读不到"变成"没有限制"）。
      if (current === 'missing' || current === stamp) return cached
      const previous = cached
      const next = await loadFromDisk()
      // 内容其实一样（例如只是被 touch 过）就不推进版本号，免得乐观并发误报冲突。
      if (JSON.stringify(previous) !== JSON.stringify(next)) revision += 1
      return next
    },
    save: async (next) => {
      await writeJsonAtomic(options.path, next)
      cached = next
      stamp = await fingerprint()
      revision += 1
    },
    current: () => {
      if (cached === null) throw new Error(`store ${options.path} 尚未加载`)
      return cached
    },
    version: () => revision,
    path: options.path,
  }
}

/** 往 JSONL 里追加一条记录（一行一条，永不改写历史）。 */
export async function appendJsonl(path: string, record: unknown): Promise<void> {
  await ensureDir(dirname(path))
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: FILE_MODE })
}

/** 读取 JSONL 文件。 */
export interface JsonlReadResult {
  /** 解析成功的行（顺序与文件一致）。 */
  readonly rows: readonly unknown[]
  /** 解析失败的行数（坏行不阻断查询，但要如实计数——静默吞掉就等于审计有洞）。 */
  readonly broken: number
  /** 文件是否超过读取上限而被截断（只读最后一段）。 */
  readonly truncated: boolean
}

/**
 * 读 JSONL。
 * @param path - 文件路径。
 * @param options - `maxBytes` 读取上限（默认 32 MiB，超出则只读文件尾部）。
 * @returns 行与统计。
 */
export async function readJsonl(path: string, options: { readonly maxBytes?: number } = {}): Promise<JsonlReadResult> {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024
  let text: string
  let truncated = false
  try {
    const buffer = await readFile(path)
    if (buffer.byteLength > maxBytes) {
      text = buffer.subarray(buffer.byteLength - maxBytes).toString('utf8')
      truncated = true
      // 截断后第一行很可能是半截，丢掉它。
      const firstBreak = text.indexOf('\n')
      text = firstBreak === -1 ? '' : text.slice(firstBreak + 1)
    } else {
      text = buffer.toString('utf8')
    }
  } catch {
    return { rows: [], broken: 0, truncated: false }
  }
  const rows: unknown[] = []
  let broken = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      broken += 1
    }
  }
  return { rows, broken, truncated }
}

/** 数据目录下的固定文件名。 */
export const DATA_FILES = {
  admins: 'admins.json',
  roles: 'roles.json',
  whitelist: 'whitelist.json',
  flags: 'flags.json',
  audit: 'audit.jsonl',
} as const

/** 取某个数据文件的绝对路径。 */
export function dataFilePath(dataDir: string, name: keyof typeof DATA_FILES): string {
  return join(dataDir, DATA_FILES[name])
}
