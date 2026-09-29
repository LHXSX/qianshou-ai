/**
 * 上游密钥的**受控**读写：只碰凭据文件 `refs:` 段里的那一个值，别的一律不动。
 *
 * ## 这个文件为什么必须存在
 *
 * 用户原话："后期能改吗" —— 在那之前，换一把上游密钥是**登服务器手改文件 +
 * 重启工作台**。现在把它做成受控操作，于是"谁能改、改了记什么、改错了怎么办"
 * 都必须有明确答案。
 *
 * ## 三条硬约束（都是实测出来的，不是推测）
 *
 * 1. **写入格式不能自己发明。** 凭据文件由 `dsh-credentials-local` 拥有，它的
 *    解析器 `parseCredentialsDocument` 会**拒绝**未知顶层键、`version !== 1`、
 *    以及不通用的键名。所以我们**只能**改 `refs:` 里那个值：既不加自己的元数据段，
 *    也不重排别人的内容。把关的工具放哪都行，放进这个文件里就会让工作台起不来。
 *
 * 2. **权限位必须是 `0600`。** `assertOwnerOnly()` 在 group/other 有任何权限位时
 *    **抛错**，而那个错误发生在凭据插件加载阶段 —— 也就是"工作台重启后
 *    凭据服务直接没了"。所以写入时固定 `0600`，替换后还要再核一次。
 *
 * 3. **值必须是裸标量，不能带引号。** 模型网关有两条取值路径，对引号的处理
 *    **不一致**：
 *      - 凭据服务路径（yaml 解析器）：正确剥掉引号；
 *      - 网关的文件兜底路径 `refFromFile`：用自写正则 `^\s+REF:\s*(\S.*)$` 取值，
 *        **原样保留引号** —— 于是 `"sk-xxx"` 会被当成 key 的一部分送给上游，
 *        上游回 401，而现象看起来像"密钥不对"。
 *    两条路径行为不一致时，**以更严的那条为准**：写裸标量。`assertStorableValue`
 *    把这条约束变成显式校验，而不是指望调用方记得。
 *
 * ## 与工作台并发的处理
 *
 * 工作台自己的凭据插件也会写这个文件（记录刷新、别的引用写入）。我们复用它
 * **同一套跨进程写者锁协议**（`<file>.lock` 由 `wx` 独占创建），所以
 * "读—改—写"这一轮不会被另一个写者插进来把状态顶掉。读侧不加锁：
 * 提交是 `rename`，读者只会看到完整的旧内容或完整的新内容。
 *
 * 本模块**只用 node 内置能力**，不引任何第三方依赖 —— 部署形态是
 * `node src/main.ts serve`（Node 22 类型剥离直接跑源码，见
 * `qianshou-admin-console.service`），引包会让那台机器上直接起不来。
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 凭据文件名（与 `dsh-credentials-local` 的 `CREDENTIALS_FILENAME` 一致）。 */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/** 备份文件名里嵌的时间戳格式：`20260917T060102Z`。 */
export function backupStamp(at: number): string {
  return new Date(at).toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/** 权限位里"属主之外"的那部分（与凭据体系同一个判据）。 */
const GROUP_OTHER_BITS = 0o077

/** 文档版本（凭据体系当前只读 1）。 */
const DOCUMENT_VERSION = 1

/** 允许的顶层键。**多一个都会被凭据解析器拒绝**，所以这里也不接受。 */
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(['version', 'refs', 'records'])

/** 指纹长度（sha256 十六进制前若干位）。 */
export const FINGERPRINT_LENGTH = 8

/**
 * 值指纹：`sha256` 前 8 位十六进制。
 *
 * 为什么不是"末 4 位"：末 4 位是明文的**一部分**，任何拿到审计文件的人都能把它
 * 和手里的候选密钥比对，等于半个泄漏通道。哈希前缀与明文无关，只够回答
 * "这次改的和上次改的是不是同一把"。**它也不进列表以外的地方**。
 * @param value - 明文值（只在内存里出现，不落盘）。
 * @returns 8 位十六进制指纹。
 */
export function fingerprintOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, FINGERPRINT_LENGTH)
}

/**
 * 该引用在进程环境里是否已被更外层提供。
 *
 * 网关的解析顺序是"凭据服务 → 环境变量 → 文件"，而凭据服务的 `resolve` 里
 * 环境变量也排在文件之前。所以只要环境里有这个键，**我们写文件是不生效的** ——
 * 这必须让管理员看见，否则他会得到一个"改了但没变"的谜题。
 *
 * 注意严格性：这里只能观测**管理台进程**的环境。工作台的 systemd 单元
 * 实测没有注入该变量（只有 `DSH_HOME` 等），所以操作上等价；
 * 万一哪天注入了，这条警告就是唯一的提示。
 * @param ref - 引用名。
 * @param env - 环境表（测试注入）。
 * @returns 环境是否提供了非空值。
 */
export function shadowedByEnvironment(ref: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[ref]
  return value !== undefined && value.trim().length > 0
}

/**
 * 引用名是否可写。
 *
 * 与凭据体系同样的严格度：名字里出现空白、引号、`:`、`#` 都会在 YAML 文档里
 * 变得有歧义 —— 而歧义在"一个只存密钥的文件"里就是故障。
 * @param ref - 引用名。
 * @returns 可写返回 `null`，否则返回给管理员看的原因。
 */
export function refRejectionReason(ref: string): string | null {
  if (ref.length === 0) return '键名不能为空。'
  if (ref.length > 128) return '键名过长（上限 128 字符）。'
  if (!/^[A-Za-z0-9_.\-/]+$/.test(ref)) {
    return '键名只能包含字母、数字、下划线、点、连字符与斜杠。'
  }
  if (ref.startsWith('.') || ref.endsWith('.')) return '键名不能以点开头或结尾。'
  return null
}

/**
 * 值是否可写（**裸标量**的可行性判定）。
 *
 * 被拒的每一种写法都能说清"为什么它在网关那里会读坏"，而不是笼统说"非法字符"：
 * 空白/引号/`#` 会让裸标量在 YAML 里有歧义；首尾空白会静默改变值；
 * 控制字符根本不是有效的 YAML 标量。
 * @param value - 明文值。
 * @returns 可写返回 `null`，否则返回可直接展示的原因。
 */
export function valueRejectionReason(value: string): string | null {
  if (value.length === 0) return '密钥不能为空；要清空请用"清除密钥"操作。'
  if (value.length > 512) return '密钥过长（上限 512 字符）。'
  if (value !== value.trim()) return '密钥首尾不能有空白字符（网关读取时会被静默改变）。'
  if (/\s/.test(value)) return '密钥不能包含空白字符（空格、制表符、换行）。'
  if (/["'`]/.test(value)) return '密钥不能包含引号（引号会被网关的文件兜底路径当成密钥的一部分）。'
  if (value.includes('#')) return '密钥不能包含 #（在 YAML 里会变成注释，值会被截断）。'
  // eslint-disable-next-line no-control-regex -- 控制字符正是这里要挡的东西
  if (/[\u0000-\u001f\u007f]/.test(value)) return '密钥不能包含控制字符。'
  return null
}

/** 一段 YAML 文档的解析结果。 */
export interface ParsedRefsDocument {
  readonly version: number
  readonly refs: ReadonlyMap<string, string>
  /** `refs:` 段在原文里的行区间（含端点），供就地编辑用。 */
  readonly refsRange: { readonly start: number; readonly end: number } | null
  /** `refs:` 顶格定义行是否存在（顶格 `refs:` 表头）。 */
  readonly hasRefsHeader: boolean
  /** 原文是否为空（空文档是合法的空存储，不需要 version）。 */
  readonly empty: boolean
}

/** 解析失败时给出的原因（带 code，便于接口返回可判别的错误）。 */
export class CredentialsDocumentError extends Error {
  /**
   * 机器可读的错误码。
   *
   * ⚠️ 刻意**不写**成构造器参数属性（`constructor(public readonly code: …)`）：
   * 部署形态是 Node 22.23.2 直接跑 `.ts`（类型剥离模式），而参数属性是
   * **不可擦除语法**，在那个模式下会 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`
   * —— 整个管理台起不来。已在服务器上实测确认（见交付说明）。
   */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CredentialsDocumentError'
    this.code = code
  }
}

/** 顶格（列 0）非空非注释行 = 一个顶层键。 */
const TOP_LEVEL_LINE = /^([A-Za-z0-9_.\-]+):/

/**
 * 解析凭据文档，**按凭据体系那套严格度**。
 *
 * 为什么自己解析而不是引 `yaml`：部署形态直接跑源码，引包会让那台机器起不来。
 * 为什么敢自己解析：我们只读两种形状（顶格 `refs:` 表头 + 两空格缩进的
 * `键: 值`），而这正是凭据体系自己写出来的形状 —— 遇到别的形状就**明确报错**，
 * 不猜、不改。
 *
 * 严格度刻意与 `parseCredentialsDocument` 对齐，哪怕看起来苛刻：这个文件里只存
 * 密钥，一个被静默忽略的条目表现为"我存的密钥没生效"。所以我们宁可拒绝操作，
 * 也不写一个自己都看不懂的文档。
 * @param text - 文件原文。
 * @returns 解析结果。
 * @throws {CredentialsDocumentError} 文档结构与凭据体系不兼容时。
 */
export function parseRefsDocument(text: string): ParsedRefsDocument {
  const lines = text.split('\n')
  const nonEmpty = lines.filter(line => line.trim().length > 0 && !line.trimStart().startsWith('#'))
  if (nonEmpty.length === 0) {
    return { version: DOCUMENT_VERSION, refs: new Map(), refsRange: null, hasRefsHeader: false, empty: true }
  }

  // 顶层键清点：既要校验 version 存在且为 1，也要拒绝未知顶层键
  // （凭据解析器会拒绝，我们在写之前就拒绝）。
  const topLevel = new Map<string, number>()
  for (const [index, line] of lines.entries()) {
    const match = TOP_LEVEL_LINE.exec(line)
    if (match === null) continue
    const key = match[1] as string
    if (topLevel.has(key)) {
      throw new CredentialsDocumentError('duplicate_top_level', `凭据文件里顶层键「${key}」出现了不止一次，请先人工修好再改密钥。`)
    }
    topLevel.set(key, index)
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new CredentialsDocumentError('unknown_top_level', `凭据文件里有本管理台不认识的顶层键「${key}」；为免写坏它，已拒绝操作。`)
    }
  }

  const versionLine = topLevel.get('version')
  if (versionLine === undefined) {
    throw new CredentialsDocumentError('missing_version', '凭据文件缺少 version: 1（这是发布前的扁平布局），请先按凭据体系的方式迁移。')
  }
  // 值就取冒号之后的那一段；解析不出来（`version:` 后面接对象之类）按无法识别处理。
  const rawVersion = /^version:\s*(\S+)\s*$/.exec(lines[versionLine] as string)?.[1]
  const version = rawVersion === undefined ? Number.NaN : Number(rawVersion)
  if (version !== DOCUMENT_VERSION) {
    throw new CredentialsDocumentError('unsupported_version', `凭据文件声明 version: ${Number.isNaN(version) ? '无法识别' : String(version)}，本管理台只认 ${DOCUMENT_VERSION}。`)
  }

  // `refs:` 段的行区间：从表头下一行到下一个顶格行（或文件尾）。
  const header = topLevel.get('refs')
  if (header === undefined) {
    return { version, refs: new Map(), refsRange: null, hasRefsHeader: false, empty: false }
  }
  let end = lines.length
  for (const [key, index] of topLevel) {
    if (key === 'refs') continue
    if (index > header && index < end) end = index
  }
  const refs = parseRefEntries(lines, header + 1, end)
  return { version, refs, refsRange: { start: header + 1, end }, hasRefsHeader: true, empty: false }
}

/**
 * 读 `refs:` 段里的条目。
 *
 * 只认同一种形状：**两空格缩进** + `键: 值`，值非空。制表符会报错而不是当成缩进——
 * YAML 不允许用制表符缩进，而"看着像缩进、实际上不是"正是最难查的那类故障。
 * @param lines - 文档按行拆开的结果。
 * @param start - 区间起始行号（含）。
 * @param end - 区间结束行号（不含）。
 * @returns 键 → 值。
 */
function parseRefEntries(lines: readonly string[], start: number, end: number): Map<string, string> {
  const refs = new Map<string, string>()
  for (let index = start; index < end; index += 1) {
    const line = lines[index] as string
    if (line.trim().length === 0) continue
    if (line.includes('\t')) {
      throw new CredentialsDocumentError('tab_indent', '凭据文件的 `refs:` 段里有制表符；YAML 不允许用制表符缩进，请先人工修好。')
    }
    if (!line.startsWith('  ')) {
      throw new CredentialsDocumentError('bad_indent', `凭据文件第 ${index + 1} 行的缩进不是两空格，本管理台不猜它的含义。`)
    }
    const match = /^ {2}([^\s:#][^:]*):\s*(.*)$/.exec(line)
    if (match === null) {
      throw new CredentialsDocumentError('bad_entry', `凭据文件第 ${index + 1} 行不是「键: 值」形状。`)
    }
    const ref = (match[1] as string).trim()
    const raw = (match[2] as string).trim()
    if (raw.length === 0) continue
    if (raw.startsWith('*') || raw.startsWith('&')) {
      throw new CredentialsDocumentError('unsupported_scalar', `凭据文件里的「${ref}」用了 YAML 锚点/别名，本管理台不猜它的值。`)
    }
    if (refs.has(ref)) {
      throw new CredentialsDocumentError('duplicate_ref', `凭据文件的 refs 段里「${ref}」出现了不止一次。`)
    }
    refs.set(ref, raw)
  }
  return refs
}

/**
 * 生成"把某个引用设成新值"之后的文档原文。
 *
 * **只动那一行**：命中就替换值，未命中就插到 `refs:` 段末尾（保留原有的顺序，
 * 不把别人的键排乱）。其余每一行 —— 注释、空行、`records:` 段的缩进 —— 逐字节保持。
 * @param text - 当前文档原文（文件不存在时传 `undefined`）。
 * @param ref - 引用名。
 * @param value - 新的裸标量值，或 `undefined` 表示删除该键。
 * @returns 新的文档原文。
 * @throws {CredentialsDocumentError} 文档结构不被接受时。
 */
export function renderRefUpdate(text: string | undefined, ref: string, value: string | undefined): string {
  const source = text ?? ''
  const doc = parseRefsDocument(source)

  if (!doc.hasRefsHeader) {
    // 空文档或没有 `refs:` 段：新建一段。空文档要先补上 version ——
    // 缺 version 的文档会被凭据解析器**拒绝**，写出去等于弄坏工作台的凭据加载。
    if (value === undefined) return source
    const base = doc.empty ? `version: ${DOCUMENT_VERSION}\n` : source
    const prefix = base.length > 0 && !base.endsWith('\n') ? `${base}\n` : base
    return `${prefix}refs:\n  ${ref}: ${value}\n`
  }

  const lines = source.split('\n')
  const range = doc.refsRange as { start: number; end: number }
  let target = -1
  for (let index = range.start; index < range.end; index += 1) {
    if (/^ {2}([^\s:#][^:]*):/.exec(lines[index] as string)?.[1]?.trim() === ref) {
      target = index
      break
    }
  }
  if (value === undefined) {
    if (target === -1) return source
    lines.splice(target, 1)
    return lines.join('\n')
  }
  if (target !== -1) {
    lines[target] = `  ${ref}: ${value}`
    return lines.join('\n')
  }
  // 插在 `refs:` 段里最后一行的后面（跳过段尾的空行，免得把新键甩到文件更后面）。
  let insertAt = range.end
  while (insertAt > range.start && (lines[insertAt - 1] as string).trim().length === 0) insertAt -= 1
  lines.splice(insertAt, 0, `  ${ref}: ${value}`)
  return lines.join('\n')
}

/**
 * 写入前的**兼容性校验**：用凭据体系自己的严格度再核一遍生成的文档。
 *
 * 为什么不靠"测试里跑一遍"就够：这个函数的判据是"工作台下次能不能读懂"，
 * 而误判的代价是工作台起不来。所以把可判定的部分做成纯函数，
 * 让它在**每次写入前**都跑一次，而不只在测试里跑。
 * @param text - 待写入的文档原文。
 * @returns 问题清单（空数组 = 通过）。
 */
export function compatibilityProblems(text: string): readonly string[] {
  const problems: string[] = []
  const lines = text.split('\n')
  const declared: string[] = []
  for (const line of lines) {
    if (line.trim().length === 0 || line.startsWith('#')) continue
    const match = TOP_LEVEL_LINE.exec(line)
    if (match !== null) declared.push(match[1] as string)
  }
  for (const key of declared) {
    if (!TOP_LEVEL_KEYS.has(key)) problems.push(`顶层键「${key}」不被凭据体系接受。`)
  }
  if (declared.length > 0) {
    if (!declared.includes('version')) problems.push('文档缺少 `version` 顶层键。')
    const versionLine = lines.find(line => TOP_LEVEL_LINE.exec(line)?.[1] === 'version') ?? ''
    if (!new RegExp(`^version:\\s*${DOCUMENT_VERSION}\\s*$`).test(versionLine)) {
      problems.push(`文档的 \`version\` 不是 ${DOCUMENT_VERSION}。`)
    }
  }
  const seen = new Set<string>()
  for (const key of declared) {
    if (seen.has(key)) problems.push(`顶层键「${key}」重复。`)
    seen.add(key)
  }
  return problems
}

/** 一次写入的结果。 */
export interface KeyWriteResult {
  readonly fingerprint: string
  readonly previousFingerprint: string | null
  /** 备份文件的绝对路径（回滚凭据）。改之前文件不存在时为 `null`。 */
  readonly backupPath: string | null
  /**
   * "改之前文件根本不存在"的标记文件路径。
   *
   * 它存在的意义：回滚时要知道该**删掉新文件**而不是还原一份内容。把它显式回传，
   * 是为了让"当时到底有没有文件"这件事留在记录里 —— 不靠调用方去猜文件名。
   */
  readonly backupAbsentMarker: string | null
  readonly updatedAt: number
}

/** 密钥存储句柄。 */
export interface UpstreamKeyStore {
  /** 凭据文件绝对路径。 */
  readonly credentialsPath: string
  /** 列出 `refs:` 段里的键名与值（**值只在内存里**，调用方不许外传）。 */
  readonly readEntries: () => Promise<ReadonlyMap<string, string>>
  /** 文件的状态（存在性、权限、更新时间）。 */
  readonly statFile: () => Promise<{ readonly exists: boolean; readonly mode: number | null; readonly mtimeMs: number | null }>
  /** 备份目录。 */
  readonly backupDir: string
  /** 写入一个引用（备份 → 加锁 → 原子替换 → 校验 → 失败回滚）。 */
  readonly writeKey: (ref: string, value: string) => Promise<KeyWriteResult>
  /**
   * 删除一个引用（走**同一条**写入协议）。
   *
   * 存在的理由：号池的"移除一个号"必须真的把 `refs:` 段里那一行删掉 ——
   * 只删管理台的元数据会留下一个**还能被网关取到**的凭据，那是最坏的一种"删成功"。
   * 而删除如果不复用这条协议，就会漏掉备份、跨进程锁、原子替换、权限复核与回滚。
   */
  readonly deleteKey: (ref: string) => Promise<KeyWriteResult>
}

/** 写者锁等待上限：与凭据体系同一个数量级（它给记录写入 30 秒）。 */
const LOCK_WAIT_MS = 30_000

/**
 * 建密钥存储。
 * @param options - `dshHome`（凭据文件所在目录）与备份目录。
 * @returns 句柄。
 */
export function createUpstreamKeyStore(options: {
  readonly dshHome: string
  readonly backupDir: string
  readonly now?: () => number
}): UpstreamKeyStore {
  const now = options.now ?? (() => Date.now())
  const credentialsPath = join(options.dshHome, CREDENTIALS_FILENAME)

  const readText = async (): Promise<string | undefined> => {
    try {
      return await readFile(credentialsPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  return {
    credentialsPath,
    backupDir: options.backupDir,
    readEntries: async () => parseRefsDocument(await readText() ?? '').refs,
    statFile: async () => {
      try {
        const info = await stat(credentialsPath)
        return { exists: true, mode: info.mode & 0o777, mtimeMs: info.mtimeMs }
      } catch {
        return { exists: false, mode: null, mtimeMs: null }
      }
    },

    /**
     * 写入一个引用。见 `commitRef`。
     * @param ref - 引用名。
     * @param value - 明文值（不落日志、不进审计）。
     * @returns 写入结果（含新旧指纹与备份路径）。
     */
    writeKey: async (ref, value) => await commitRef(ref, value),

    /**
     * 删除一个引用（走**同一条**协议）。
     *
     * 号池的"移除一个号"必须真的把 `refs:` 段里那一行删掉：只删管理台的元数据会留下
     * 一个**还能被网关取到**的凭据，那是最坏的一种"删成功"。
     * @param ref - 引用名。
     * @returns 写入结果（`fingerprint` 为空串：删除之后没有"新指纹"这回事）。
     */
    deleteKey: async ref => await commitRef(ref, undefined),
  }

  /**
   * 写入或删除一个引用。**这是唯一动凭据文件的路径。**
   *
   * 顺序刻意是"先备份、再加锁、再替换"：
   * - **备份在锁外**：备份是要给人看的回滚点，它的名字带时间戳；放在锁内只会
   *   拉长锁的持有时间，而锁是跨进程的。
   * - **加锁之后再读一次**：锁内读到的一定是最新提交，否则"读—改—写"会
   *   把另一个写者刚落盘的状态顶掉。
   * - **写完再核一次权限与兼容性**：替换后的文件权限必须是 `0600`
   *   （凭据体系对 group/other 权限位**抛错**，那会让工作台重启后加载不了
   *   凭据插件）；文档必须仍能被凭据体系读懂。
   * - **任何一步失败都回滚**：回滚用刚才那份备份，且回滚本身也走原子替换。
   * @param ref - 引用名。
   * @param value - 新值；`undefined` 表示删除该引用。
   * @returns 写入结果。
   * @throws {CredentialsDocumentError} 键名/值不合法、文档读不懂、或要删的目标不存在时。
   */
  async function commitRef(ref: string, value: string | undefined): Promise<KeyWriteResult> {
    const refProblem = refRejectionReason(ref)
    if (refProblem !== null) throw new CredentialsDocumentError('bad_ref', refProblem)
    if (value !== undefined) {
      const valueProblem = valueRejectionReason(value)
      if (valueProblem !== null) throw new CredentialsDocumentError('bad_value', valueProblem)
    }

    // 备份目录必须先建出来：它是下面每个回滚点（连 `.absent` 标记）的父目录，
    // 少了这一步，标记与备份都会因为"父目录不存在"而写不出去。
    await mkdir(options.backupDir, { recursive: true, mode: 0o700 })
    const before = await readText()
    const beforeRefs = before === undefined ? null : parseRefsDocument(before).refs
    if (value === undefined && (beforeRefs === null || !beforeRefs.has(ref))) {
      // 删一个不存在的东西**不是成功**：报告成功会让"号池里少了一个号"
      // 变成一次静默的假动作。
      throw new CredentialsDocumentError('ref_not_found', `凭据文件里没有「${ref}」，没有可删除的条目。`)
    }
    const previousValue = beforeRefs?.get(ref)
    const previousFingerprint = previousValue === undefined ? null : fingerprintOf(previousValue)

    // 备份：即使文件不存在也留一份"当时不存在"的标记，回滚时才知道该删掉新文件。
    //
    // ⚠️ 备份路径必须**防撞名**：时间戳只精确到秒，同一秒里改两次会写到同一个文件名，
    // 于是第一份回滚点被无声覆盖 —— 而"回滚点被覆盖"正好破坏了这个功能存在的理由。
    // 这里在撞名时追加序号（并在写之前"占位"创建，避免两个进程同时选中同一个名字）。
    const stamp = backupStamp(now())
    const base = join(options.backupDir, `${CREDENTIALS_FILENAME}.${stamp}.bak`)
    const backupPath = before === undefined ? base : await reserveUnusedPath(base)
    const absentMarker = before === undefined ? `${backupPath}.absent` : null
    if (before === undefined) {
      await writeFile(absentMarker as string, '', { mode: 0o600, flag: 'wx' })
    } else {
      // `reserveUnusedPath` 已经用空文件占住这个名字，这里覆盖成真实内容。
      await writeFile(backupPath, before, { mode: 0o600 })
    }
    const rollbackSource = before === undefined ? null : backupPath

    await mkdir(dirname(credentialsPath), { recursive: true, mode: 0o700 })

    await withWriterLock(credentialsPath, async () => {
      // 锁内重读：另一个写者（工作台的凭据插件）可能刚提交过。
      const current = await readText()
      const nextText = renderRefUpdate(current, ref, value)
      const problems = compatibilityProblems(nextText)
      if (problems.length > 0) {
        throw new CredentialsDocumentError('incompatible_document', `生成的凭据文档会被工作台拒绝，已中止写入：${problems.join(' ')}`)
      }
      try {
        await writeFileAtomic0600(credentialsPath, nextText)
      } catch (error) {
        await rollback(credentialsPath, rollbackSource)
        throw error
      }
      // 替换后复核：权限位不对会直接让工作台重启后加载不了凭据插件。
      const after = await lstat(credentialsPath)
      if ((after.mode & GROUP_OTHER_BITS) !== 0) {
        // 先自己修，修不成才是真故障。
        try {
          await chmod(credentialsPath, 0o600)
        } catch {
          await rollback(credentialsPath, rollbackSource)
          throw new CredentialsDocumentError('mode_not_owner_only', '凭据文件替换后权限比 0600 宽，且收紧失败；已回滚。')
        }
      }
    })

    return {
      // 删除没有"新指纹"：空串是**没有值**的显式表示，比留一个旧指纹诚实。
      fingerprint: value === undefined ? '' : fingerprintOf(value),
      previousFingerprint,
      backupPath: rollbackSource === null ? null : backupPath,
      backupAbsentMarker: absentMarker,
      updatedAt: now(),
    }
  }
}

/**
 * 占一个还没被用过的备份文件名。
 *
 * 时间戳只精确到秒，而"同一秒里改两次"在真实运维里完全会发生（改错了立刻再改一次）。
 * 撞名就静默覆盖第一份回滚点 —— 那正好把备份功能的意义抹掉。所以这里在撞名时
 * 追加序号，并用 `wx` 独占创建**占住**名字（两个进程同时选中同一名字时，
 * 后一个会拿到 EEXIST 再试下一个）。
 * @param base - 基础路径（含时间戳）。
 * @returns 可安全使用的路径。
 */
async function reserveUnusedPath(base: string): Promise<string> {
  for (let index = 0; index < 1000; index += 1) {
    const candidate = index === 0 ? base : `${base}.${index}`
    try {
      await writeFile(candidate, '', { mode: 0o600, flag: 'wx' })
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new CredentialsDocumentError('backup_name_exhausted', '备份文件名冲突过多，已中止写入。')
}

/**
 * 原子替换（临时文件 `wx` 独占创建 → `rename`）。
 *
 * 与宿主 `writeFileAtomic` 同构，但**不引那个包**：部署形态是直接跑源码，
 * 引包会让服务器上起不来。这里保留它的两个关键性质：临时文件用 `wx` 打开
 * （拒绝顺着别人埋的符号链接写），`rename` 在同一文件系统上是原子的
 * （读者只会看到完整的旧内容或完整的新内容）。
 * @param filename - 目标路径。
 * @param content - 完整的新内容。
 */
async function writeFileAtomic0600(filename: string, content: string): Promise<void> {
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' })
    await rename(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * 回滚到备份内容。
 *
 * 备份不存在（写入前文件本来就不存在）时删掉新文件 —— 那才是"回到改之前"。
 * 回滚失败**不吞**：那意味着磁盘上留了一个我们无法解释的状态，必须让
 * 管理员看到，而不是报告一个假的"已回滚"。
 * @param filename - 目标路径。
 * @param backupPath - 备份路径；`null` 表示改之前文件不存在。
 */
async function rollback(filename: string, backupPath: string | null): Promise<void> {
  if (backupPath === null) {
    await rm(filename, { force: true })
    return
  }
  await writeFileAtomic0600(filename, await readFile(backupPath, 'utf8'))
}

/**
 * 跨进程写者锁（与凭据体系同一套协议）。
 *
 * 锁是 `<file>.lock`，由 `wx` 独占创建；竞争按指数退避重试，超时失败而不是
 * 猜测锁的持有者是否还活着（文件年龄证明不了这件事）。**绝不删除别人的锁** ——
 * 孤儿锁是运维动作，不是我们的自动行为。
 * @param filename - 被保护的文件。
 * @param operation - 持锁执行的操作。
 */
async function withWriterLock<T>(filename: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + LOCK_WAIT_MS
  let delay = 20
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'EPERM') throw error
    }
    if (Date.now() >= deadline) {
      throw new CredentialsDocumentError('lock_timeout', `等待凭据文件的写者锁超时（${lockPath}）。可能有另一个进程正在写；请稍后重试。`)
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, 200)
  }
  try {
    return await operation()
  } finally {
    await rm(lockPath, { force: true })
  }
}
