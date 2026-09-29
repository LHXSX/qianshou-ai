import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extendArchiveManifest,
  gitBlobHash,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
  type ArchiveManifest,
} from './archived-agent-notes.ts'
import { isArchivedAgentNotePath } from './repo-files.ts'
import { AGENT_NOTE_CLASSES } from './agent-note-tree.ts'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

const scratch: string[] = []
afterEach(() => { for (const path of scratch.splice(0)) removeFixtureSafely(path) })

function fixture(): Map<string, Buffer> {
  const base = '2026-07-26-example'
  const source = Buffer.from(`# Agent Note: Example\n\nStatus: implemented\nArchived: 2026-07-26\n\nEnglish | [中文](${base}.zh.md)\n\n## Problem\n\nExample.\n`)
  const zh = Buffer.from(`# Agent Note: 示例\n\nStatus: implemented\nArchived: 2026-07-26\n\n[English](${base}.md) | 中文\n\n## 问题\n\n示例。\n`)
  const meta = Buffer.from(`${base}.md: ${gitBlobHash(source)}\n${base}.zh.md: ${gitBlobHash(zh)}\n`)
  return new Map([
    [`process/${base}.md`, source],
    [`process/${base}.zh.md`, zh],
    [`process/${base}.i18n.yaml`, meta],
  ])
}

describe('archived Agent Notes', () => {
  for (const prefix of ['', '源码/Mac PC']) {
    it(`reads the committed archive in ${prefix || 'root'} and rejects replaced seals`, () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-archive-git-'))
      scratch.push(root)
      const project = join(root, prefix)
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, 'package.json'), '{"type":"module"}\n')
      const scripts = join(project, 'scripts')
      mkdirSync(scripts, { recursive: true })
      for (const name of ['verify-archived-agent-notes.ts', 'archived-agent-notes.ts', 'agent-note-tree.ts']) {
        copyFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), join(scripts, name))
      }
      const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Archive Test', GIT_AUTHOR_EMAIL: 'archive@example.test',
        GIT_COMMITTER_NAME: 'Archive Test', GIT_COMMITTER_EMAIL: 'archive@example.test' }
      const git = (args: string[]) => {
        const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
        expect(result.status, result.stderr).toBe(0)
      }
      git(['init', '--quiet', root])
      const archive = join(project, '.agents/notes/archived')
      for (const kind of AGENT_NOTE_CLASSES) mkdirSync(join(archive, kind), { recursive: true })
      writeFileSync(join(archive, 'AGENTS.md'), '# Frozen archive\n')
      const artifacts = fixture()
      for (const [path, content] of artifacts) {
        const target = join(archive, path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, content)
      }
      writeFileSync(join(archive, 'manifest.json'), renderArchiveManifest(
        extendArchiveManifest({ version: 1, files: {} }, artifacts).files))
      git(['add', '.'])
      git(['commit', '--quiet', '-m', 'sealed archive'])
      const run = () => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
        join(scripts, 'verify-archived-agent-notes.ts')], { cwd: project, env, encoding: 'utf8', timeout: 30_000 })
      const valid = run()
      expect(valid.status, valid.stderr).toBe(0)
      const replaced = new Map(artifacts)
      replaced.set('process/2026-07-26-example.md', Buffer.from('changed'))
      writeFileSync(join(archive, 'process/2026-07-26-example.md'), 'changed')
      writeFileSync(join(archive, 'manifest.json'), renderArchiveManifest(
        extendArchiveManifest({ version: 1, files: {} }, replaced).files))
      const invalid = run()
      expect(invalid.status).toBe(1)
      expect(invalid.stderr).toContain('sealed manifest hash changed')
    })
  }
  it('recognizes archived paths with POSIX and Windows separators', () => {
    expect(isArchivedAgentNotePath('.agents/notes/archived/process/example.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents\\notes\\archived\\process\\example.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents/notes/implemented/process/example.md')).toBe(false)
  })

  it('accepts one complete implemented triplet with matching archive metadata', () => {
    expect(validateArchiveArtifacts(fixture())).toEqual([])
  })

  it('rejects incomplete triplets and invalid archive headers', () => {
    const artifacts = fixture()
    artifacts.delete('process/2026-07-26-example.i18n.yaml')
    artifacts.set(
      'process/2026-07-26-example.md',
      Buffer.from('# Agent Note: Example\n\nStatus: proposed\nArchived: yesterday\n'),
    )
    expect(validateArchiveArtifacts(artifacts).join('\n')).toMatch(/incomplete archived triplet/)
  })

  it('extends the manifest without permitting a sealed change or removal', () => {
    const artifacts = fixture()
    const empty: ArchiveManifest = { version: 1, files: {} }
    const first = extendArchiveManifest(empty, artifacts)
    expect(first.errors).toEqual([])
    expect(first.added).toHaveLength(3)

    const sealed: ArchiveManifest = { version: 1, files: first.files }
    const changed = new Map(artifacts)
    changed.set('process/2026-07-26-example.md', Buffer.from('changed'))
    expect(extendArchiveManifest(sealed, changed).errors).toEqual([
      'process/2026-07-26-example.md: sealed content hash changed',
    ])
    changed.delete('process/2026-07-26-example.zh.md')
    expect(extendArchiveManifest(sealed, changed).errors).toContain(
      'process/2026-07-26-example.zh.md: sealed artifact is missing',
    )
  })

  it('rejects replacing manifest seals alongside changed archive content', () => {
    const artifacts = fixture()
    const initial = extendArchiveManifest({ version: 1, files: {} }, artifacts)
    const baseline: ArchiveManifest = { version: 1, files: initial.files }
    const path = 'process/2026-07-26-example.md'
    const changedArtifacts = new Map(artifacts)
    changedArtifacts.set(path, Buffer.from('changed'))
    const replacement = extendArchiveManifest({ version: 1, files: {} }, changedArtifacts)
    const current: ArchiveManifest = { version: 1, files: replacement.files }

    expect(extendArchiveManifest(current, changedArtifacts).errors).toEqual([])
    expect(validateArchiveManifestExtension(baseline, current)).toEqual([
      `${path}: sealed manifest hash changed`,
    ])
    const removed: ArchiveManifest = {
      version: 1,
      files: Object.fromEntries(Object.entries(current.files).filter(([candidate]) => candidate !== path)),
    }
    expect(validateArchiveManifestExtension(baseline, removed)).toContain(
      `${path}: sealed manifest entry is missing`,
    )
  })

  it('round-trips the deterministic manifest schema', () => {
    const content = renderArchiveManifest({ 'process/z.md': `sha256:${'a'.repeat(64)}` })
    expect(parseArchiveManifest(content)).toEqual({
      version: 1,
      files: { 'process/z.md': `sha256:${'a'.repeat(64)}` },
    })
  })
})
