/**
 * 上游密钥的**管理面元数据**：谁在什么时候换过、换出来的指纹是什么。
 *
 * ## 为什么必须单独存，而不是写进凭据文件
 *
 * 凭据文件由 `dsh-credentials-local` 拥有，它的解析器会**拒绝任何未知顶层键**。
 * 往里面塞一个"更新人/更新时间"的段，等于**让工作台下次重启时加载不了凭据插件** ——
 * 那是一个比"没有元数据"严重得多的故障。所以元数据落在管理台自己的数据目录里，
 * 与凭据文件彻底分开（这也是"两个面不互相污染"的同一个原则）。
 *
 * ## 存什么、不存什么
 *
 * 只存**指纹**与"谁、何时"。明文**在任何路径上都不落盘**：
 * 凭据文件是它的唯一归宿，而那是凭据体系的地盘。
 */
import { createJsonStore } from './store.ts'

/** 一个引用的元数据。 */
export interface KeyMetadata {
  /** 最近一次变更后的值指纹（sha256 前 8 位）。 */
  readonly fingerprint: string
  /** 变更时刻（毫秒）。 */
  readonly updatedAt: number
  /** 变更人（管理台 accountId）。 */
  readonly updatedBy: string
  /** 最近一次变更前的指纹；首次写入为 `null`。 */
  readonly previousFingerprint: string | null
}

/** 元数据文件顶层形状。 */
interface MetadataFile {
  readonly version: 1
  readonly keys: Readonly<Record<string, KeyMetadata>>
}

/** 元数据存储句柄。 */
export interface KeyMetadataStore {
  /** 读全部（每次从磁盘读；这个文件很小，且可能被 CLI 改过）。 */
  readonly load: () => Promise<Readonly<Record<string, KeyMetadata>>>
  /** 记一次变更。 */
  readonly record: (ref: string, entry: KeyMetadata) => Promise<void>
}

/** 一条记录是否可信。 */
function isMetadata(value: unknown): value is KeyMetadata {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row['fingerprint'] === 'string'
    && typeof row['updatedAt'] === 'number'
    && typeof row['updatedBy'] === 'string'
}

/** 整个文件的形状校验：坏文件当成空，**不猜**。 */
function validateFile(raw: unknown): MetadataFile | null {
  if (raw === null || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  if (row['version'] !== 1) return null
  const keys = row['keys']
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) return null
  const out: Record<string, KeyMetadata> = {}
  for (const [ref, value] of Object.entries(keys as Record<string, unknown>)) {
    if (isMetadata(value)) out[ref] = value
  }
  return { version: 1, keys: out }
}

/**
 * 建元数据存储。
 * @param path - JSON 文件路径（管理台数据目录内）。
 * @returns 句柄。
 */
export function createKeyMetadataStore(path: string): KeyMetadataStore {
  const store = createJsonStore<MetadataFile>({
    path,
    defaults: () => ({ version: 1, keys: {} }),
    validate: validateFile,
  })
  return {
    load: async () => (await store.load()).keys,
    record: async (ref, entry) => {
      const current = await store.load()
      await store.save({ version: 1, keys: { ...current.keys, [ref]: entry } })
    },
  }
}
