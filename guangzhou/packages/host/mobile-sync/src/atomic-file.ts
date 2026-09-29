/** Replace one private file in a single rename, then flush the directory entry. */
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/** Write `content` to `path` atomically with owner-only permissions.
 *
 * The temporary file is created with `wx` so a collision can never silently reuse
 * another writer's file, is flushed before the rename so the rename cannot publish
 * content that is still only in the page cache, and is removed on any failure so a
 * refused write leaves no debris beside the live file.
 * @param path - Absolute private destination path.
 * @param content - Complete replacement content.
 * @param unavailable - Error to raise when the filesystem refuses the write.
 */
export async function writePrivateAtomic(path: string, content: string, unavailable: () => Error): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const handle = await open(temporary, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    await rename(temporary, path)
  } catch {
    // 失败原因不向外暴露：调用方只需要知道"这次落盘没有成功"。
    await rm(temporary, { force: true })
    throw unavailable()
  }
}
