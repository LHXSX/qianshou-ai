import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildCanonicalOrderArchive } from '../src/order-source-archive.ts'

const SOURCE_DIGEST = 'sha256:5fa50d9c753945fd8a503e2690dbb6102f15f83ae3830273a283607f38f8ab0c'
const ARCHIVE_DIGEST = 'sha256:c54933e002b440d67f07ad916fd310151fbe6f2146e1433305fa6eb5bcd5b40c'
const files = [
  ['package.json', '{"version":"1.0.1"}\n'],
  ['pnpm-lock.yaml', 'lockfileVersion: 9.0\n'],
  ['local-adapter.json', '{"taskType":"bar_chart_svg_v1"}\n'],
  ['src/adapter.mjs', 'export default 1\n'],
  ['src/assemble_gif.py', 'print("gif")\n'],
  ['src/encode_frames.swift', 'print("mp4")\n'],
] as const

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-order-archive-'))
  roots.push(root)
  await mkdir(join(root, 'src'))
  await Promise.all(files.map(([name, bytes]) => writeFile(join(root, name), bytes)))
  return root
}

it('matches the independent Python canonical ZIP bytes and source digest', async () => {
  const root = await fixture()
  const archive = await buildCanonicalOrderArchive(root, SOURCE_DIGEST)
  expect(archive.artifactDigest).toBe(SOURCE_DIGEST)
  expect(archive.archiveDigest).toBe(ARCHIVE_DIGEST)
  expect(archive.sizeBytes).toBe(796)
  expect(archive.bytes.subarray(0, 4).toString('hex')).toBe('504b0304')
})

it('rejects modified files and links before upload', async () => {
  const root = await fixture()
  await writeFile(join(root, 'src', 'adapter.mjs'), 'export default 2\n')
  await expect(buildCanonicalOrderArchive(root, SOURCE_DIGEST)).rejects.toThrow('order-adapter-invalid')
  await rm(join(root, 'src', 'adapter.mjs'))
  await symlink(join(root, 'package.json'), join(root, 'src', 'adapter.mjs'))
  await expect(buildCanonicalOrderArchive(root, SOURCE_DIGEST)).rejects.toThrow('order-adapter-invalid')
})

it('rejects a linked source directory even when it resolves within the adapter', async () => {
  const root = await fixture()
  await rename(join(root, 'src'), join(root, 'actual-src'))
  await symlink(join(root, 'actual-src'), join(root, 'src'))
  await expect(buildCanonicalOrderArchive(root, SOURCE_DIGEST)).rejects.toThrow('order-adapter-invalid')
})
