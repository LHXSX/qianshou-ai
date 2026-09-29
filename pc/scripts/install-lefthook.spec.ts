import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { gitBlobHash } from './translation-pairing-git.ts'
import { renderTranslationPairingRecord, translationPairPaths } from './translation-pairing-record.ts'
import { removeFixtureSafely, unlinkFixtureLinks } from './test-fixture-cleanup.ts'

const pairingMergeDriver = 'scripts/merge-translation-pairing-driver.sh %O %A %B %P'
const scriptsDirectory = fileURLToPath(new URL('.', import.meta.url))
const fixtures: string[] = []

interface Fixture {
  container: string
  env: NodeJS.ProcessEnv
  linked: string
  main: string
}

interface CommandResult {
  status: number | null
  stderr: string
  stdout: string
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) removeFixtureSafely(fixture)
})

function commandResult(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env })
  return { status: result.status, stderr: result.stderr, stdout: result.stdout }
}

function gitResult(fixture: Fixture, cwd: string, args: string[]): CommandResult {
  return commandResult('git', args, cwd, fixture.env)
}

function git(fixture: Fixture, cwd: string, args: string[]): string {
  const result = gitResult(fixture, cwd, args)
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

function write(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, mode === undefined ? undefined : { mode })
}

function fakeLefthookSource(): string {
  return `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

if (process.argv.slice(2).join(' ') !== 'install --force') process.exit(64)
const rootOutput = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
const root = rootOutput.endsWith('\\n') ? rootOutput.slice(0, -1) : rootOutput
const forbiddenConfigKey = process.env.DSH_TEST_FORBIDDEN_GIT_CONFIG_KEY
if (forbiddenConfigKey !== undefined) {
  try {
    execFileSync('git', ['config', '--get', forbiddenConfigKey], { encoding: 'utf8' })
    process.exit(92)
  } catch (error) {
    if (error === null || typeof error !== 'object' || !('status' in error) || error.status !== 1) throw error
  }
}
const hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim()
mkdirSync(hooksPath, { recursive: true })
const running = join(hooksPath, '.fake-lefthook-running')
try {
  writeFileSync(running, String(process.pid), { flag: 'wx' })
} catch {
  process.exit(91)
}
const delay = Number(process.env.DSH_TEST_LEFTHOOK_DELAY_MS ?? 0)
if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
const replaceLockPath = process.env.DSH_TEST_LEFTHOOK_REPLACE_LOCK_PATH
if (replaceLockPath !== undefined) writeFileSync(replaceLockPath, 'replacement owner\\n')
const shouldFail = process.env.DSH_TEST_LEFTHOOK_FAIL === '1'
if (!shouldFail) {
  const binary = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'lefthook.cmd' : 'lefthook')
  const config = readFileSync(join(root, 'lefthook.yml'), 'utf8').trim()
  const hook = \`#!/bin/sh\\n# root=\${root}\\n# binary=\${binary}\\n# config=\${config}\\nexit 0\\n\`
  for (const name of ['pre-commit', 'pre-merge-commit', 'pre-push']) writeFileSync(join(hooksPath, name), hook, { mode: 0o755 })
}
if (existsSync(running)) unlinkSync(running)
if (process.env.DSH_TEST_LEFTHOOK_BREAK_WORKTREE_CONFIG === '1') {
  const configPath = execFileSync('git', ['rev-parse', '--git-path', 'config.worktree'], { encoding: 'utf8' }).trim()
  writeFileSync(configPath, '[invalid\\n')
}
if (shouldFail) process.exit(77)
`
}

function installFakeLefthook(root: string): void {
  write(join(root, 'package.json'), '{"type":"module"}\n')
  const binDirectory = join(root, 'node_modules/.bin')
  mkdirSync(binDirectory, { recursive: true })
  writeFileSync(join(binDirectory, 'fake-lefthook.mjs'), fakeLefthookSource())
  if (process.platform === 'win32') {
    writeFileSync(
      join(binDirectory, 'lefthook.cmd'),
      `@echo off\r\n"${process.execPath}" "%~dp0\\fake-lefthook.mjs" %*\r\n`,
    )
    return
  }
  const shim = join(binDirectory, 'lefthook')
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-lefthook.mjs" "$@"\n`)
  chmodSync(shim, 0o755)
}

function installPairingProbeFixture(root: string): void {
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  cpSync(scriptsDirectory, join(root, 'scripts'), {
    recursive: true,
    filter: path => !path.endsWith('.spec.ts'),
  })
  const dependencies = resolve(scriptsDirectory, '../node_modules')
  for (const name of readdirSync(dependencies)) {
    if (name.startsWith('.') || existsSync(join(root, 'node_modules', name))) continue
    symlinkSync(join(dependencies, name), join(root, 'node_modules', name), linkType)
  }
}

function createFixture(names: { main?: string; linked?: string } = {}): Fixture {
  const container = mkdtempSync(join(tmpdir(), 'dsh-lefthook-'))
  fixtures.push(container)
  const main = join(container, names.main ?? 'main')
  const linked = join(container, names.linked ?? 'linked')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: 'false',
    GITHUB_ACTIONS: 'false',
    GIT_AUTHOR_EMAIL: 'hooks@example.test',
    GIT_AUTHOR_NAME: 'Hooks Test',
    GIT_COMMITTER_EMAIL: 'hooks@example.test',
    GIT_COMMITTER_NAME: 'Hooks Test',
    GIT_CONFIG_GLOBAL: join(container, 'global.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: container,
    XDG_CONFIG_HOME: join(container, '.config'),
  }
  const fixture = { container, env, linked, main }
  mkdirSync(main)
  git(fixture, container, ['init', main])
  write(join(main, 'README.md'), '# fixture\n')
  git(fixture, main, ['add', 'README.md'])
  git(fixture, main, ['commit', '-m', 'fixture'])
  git(fixture, main, ['worktree', 'add', '-b', 'linked', linked])
  write(join(main, 'lefthook.yml'), 'main-worktree-config\n')
  write(join(linked, 'lefthook.yml'), 'linked-worktree-config\n')
  installFakeLefthook(main)
  installFakeLefthook(linked)
  installPairingProbeFixture(main)
  installPairingProbeFixture(linked)
  return fixture
}

function gitDirectory(fixture: Fixture, root: string): string {
  return git(fixture, root, ['rev-parse', '--absolute-git-dir'])
}

function commonDirectory(fixture: Fixture): string {
  const output = git(fixture, fixture.main, ['rev-parse', '--git-common-dir'])
  return isAbsolute(output) ? output : resolve(fixture.main, output)
}

function hooksPath(fixture: Fixture, root: string): string {
  return join(gitDirectory(fixture, root), 'dsh-hooks')
}

function installLockPath(fixture: Fixture): string {
  return join(commonDirectory(fixture), 'dsh-lefthook-install.lock')
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
}

function runInstaller(
  fixture: Fixture,
  root: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/install-lefthook.mjs')], {
      cwd: root,
      env: { ...fixture.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (status) => { resolveResult({ status, stderr, stdout }) })
  })
}

interface RealFixture extends Fixture {
  project: string
  prefix: string
}

function writeRealPair(project: string, content: string): void {
  const source = `# Pair\n\nEnglish | [中文](pair.zh.md)\n\n${content}.\n`
  const zh = `# 配对\n\n[English](pair.md) | 中文\n\n${content}。\n`
  write(join(project, 'docs/pair.md'), source)
  write(join(project, 'docs/pair.zh.md'), zh)
  write(join(project, 'docs/pair.i18n.yaml'), renderTranslationPairingRecord(translationPairPaths('docs/pair.md'), {
    sourceHash: gitBlobHash(Buffer.from(source)), zhHash: gitBlobHash(Buffer.from(zh)),
  }))
}

function realFixture(prefix: string): RealFixture {
  const container = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-real-nested-hooks-')))
  fixtures.push(container)
  const main = join(container, 'main')
  const project = join(main, prefix)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: 'false',
    GITHUB_ACTIONS: 'false',
    GIT_AUTHOR_EMAIL: 'hooks@example.test',
    GIT_AUTHOR_NAME: 'Hooks Test',
    GIT_COMMITTER_EMAIL: 'hooks@example.test',
    GIT_COMMITTER_NAME: 'Hooks Test',
    GIT_CONFIG_GLOBAL: join(container, 'global.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    LEFTHOOK_OUTPUT: 'summary',
  }
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_(?:KEY|VALUE)_\d+)$/.test(key)) {
      Reflect.deleteProperty(env, key)
    }
  }
  const fixture = { container, env, linked: main, main, project, prefix }
  mkdirSync(project, { recursive: true })
  git(fixture, container, ['init', '--initial-branch=master', main])
  cpSync(scriptsDirectory, join(project, 'scripts'), {
    recursive: true,
    filter: path => !path.endsWith('.spec.ts'),
  })
  symlinkSync(resolve(scriptsDirectory, '../node_modules'), join(project, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir')
  const bin = join(container, 'bin')
  mkdirSync(bin)
  const pnpm = resolve(scriptsDirectory, '../apps/desktop/node_modules/pnpm/bin/pnpm.mjs')
  write(join(bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'), process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${pnpm}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${pnpm}' "$@"\n`, 0o755)
  env.PATH = `${bin}${delimiter}${env.PATH ?? ''}`
  write(join(project, 'package.json'), JSON.stringify({
    type: 'module', scripts: { typecheck: 'node capture.mjs typecheck' },
  }))
  write(join(project, 'capture.mjs'), `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const [kind, ...files] = process.argv.slice(2)
appendFileSync('events.jsonl', JSON.stringify({kind, cwd:process.cwd(), files})+'\\n')
if (kind === 'lint') for (const file of files) writeFileSync(file, readFileSync(file,'utf8')+'// fixed\\n')
if (kind === 'typecheck' && process.env.DSH_TEST_FAIL_TYPECHECK === '1') process.exit(23)
`)
  write(join(project, 'lefthook.yml'), JSON.stringify({
    'pre-commit': { jobs: [
      { name: 'pairing records', glob: '*.i18n.yaml', exclude: ['.agents/notes/archived/**'],
        run: 'node capture.mjs pairing {staged_files} && node_modules/.bin/tsx scripts/verify-translation-pairing.ts --cached {staged_files}' },
      { name: 'lint', glob: '*.ts', run: 'node capture.mjs lint {staged_files}', stage_fixed: true },
      { name: 'whitespace', run: 'git diff --cached --check' },
      { name: 'vendor manifest guard', run: 'scripts/check-vendor-manifest.sh' },
    ] },
    'pre-merge-commit': { jobs: [{ name: 'merge', run: 'node capture.mjs merge' }] },
    'pre-push': { jobs: [{ name: 'typecheck', run: 'pnpm run typecheck' }] },
  }))
  write(join(project, '.gitignore'), 'node_modules/\nevents.jsonl\n')
  write(join(project, 'src/中文 file.ts'), 'export const value = 1\n')
  writeRealPair(project, 'Initial')
  write(join(project, '.agents/notes/archived/old.i18n.yaml'), 'fixture: initial\n')
  write(join(main, 'outside.ts'), 'outside\n')
  git(fixture, main, ['add', '.'])
  git(fixture, main, ['commit', '-m', 'initial'])
  return fixture
}

function installReal(fixture: RealFixture): CommandResult {
  return commandResult(process.execPath, [join(fixture.project, 'scripts/install-lefthook.mjs')],
    fixture.project, fixture.env)
}

function captured(fixture: RealFixture): { kind: string; cwd: string; files: string[] }[] {
  return readFileSync(join(fixture.project, 'events.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { kind: string; cwd: string; files: string[] })
}

// Every case builds scratch worktrees and drives them through spawned Git and
// Node subprocesses, so the suite is bound by process creation rather than by
// its assertions. The value matches DSH_COVERAGE_TEST_TIMEOUT_MS, which the
// Windows coverage lane passes as --testTimeout: a describe value overrides that
// flag rather than yielding to it, so a smaller one here lowers what the lane
// grants every case in this file, none of which carries an allowance of its own.
// Rationale and the paired hook budget are in
// .agents/notes/archived/testing/2026-08-29-windows-lane-hook-and-lefthook-budget.md.
describe('worktree-local Lefthook installer', { timeout: 90_000 }, () => {
  for (const [label, extraEnv] of [
    ['CI', { CI: 'true' }],
    ['GitHub Actions', { GITHUB_ACTIONS: 'true' }],
  ] satisfies [string, NodeJS.ProcessEnv][]) {
    it(`skips hook installation when ${label} marks an automated job`, async () => {
      const fixture = createFixture()
      const common = commonDirectory(fixture)
      const missingInclude = join(fixture.container, 'missing-ci-credentials.gitconfig')
      git(fixture, fixture.main, [
        'config',
        '--local',
        'includeIf.gitdir:/github/workspace/.git.path',
        missingInclude,
      ])

      const result = await runInstaller(fixture, fixture.main, extraEnv)

      expect(result.status, result.stderr).toBe(0)
      expect(gitResult(fixture, fixture.main, ['config', '--get', 'extensions.worktreeConfig']).status).toBe(1)
      expect(git(fixture, fixture.main, ['config', '--get', 'core.repositoryFormatVersion'])).toBe('0')
      expect(existsSync(hooksPath(fixture, fixture.main))).toBe(false)
      expect(existsSync(join(common, 'config.worktree'))).toBe(false)
      expect(gitResult(fixture, fixture.main, [
        'config', '--get', 'merge.dsh-translation-pairing.driver',
      ]).status).toBe(1)
    })
  }

  it('isolates main and linked worktrees without changing legacy common hooks', async () => {
    const fixture = createFixture()
    const common = commonDirectory(fixture)
    const legacyHook = join(common, 'hooks/pre-commit')
    write(legacyHook, '#!/bin/sh\n# legacy hook\n', 0o755)

    const mainInstall = await runInstaller(fixture, fixture.main)
    const linkedInstall = await runInstaller(fixture, fixture.linked)
    expect(mainInstall.status, mainInstall.stderr).toBe(0)
    expect(linkedInstall.status, linkedInstall.stderr).toBe(0)

    const mainHooks = hooksPath(fixture, fixture.main)
    const linkedHooks = hooksPath(fixture, fixture.linked)
    expect(mainHooks).not.toBe(linkedHooks)
    expect(git(fixture, fixture.main, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe(mainHooks)
    expect(git(fixture, fixture.linked, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe(linkedHooks)
    expect(git(fixture, fixture.main, [
      'config', '--worktree', '--get', 'merge.dsh-translation-pairing.driver',
    ])).toBe(pairingMergeDriver)
    expect(git(fixture, fixture.linked, [
      'config', '--worktree', '--get', 'merge.dsh-translation-pairing.driver',
    ])).toBe(pairingMergeDriver)

    const mainHook = readFileSync(join(mainHooks, 'pre-commit'), 'utf8')
    const linkedHook = readFileSync(join(linkedHooks, 'pre-commit'), 'utf8')
    const canonicalMain = git(fixture, fixture.main, ['rev-parse', '--show-toplevel'])
    const canonicalLinked = git(fixture, fixture.linked, ['rev-parse', '--show-toplevel'])
    expect(mainHook).toContain(`# root=${canonicalMain}`)
    expect(mainHook).toContain('# config=main-worktree-config')
    expect(mainHook).not.toContain(canonicalLinked)
    expect(linkedHook).toContain(`# root=${canonicalLinked}`)
    expect(linkedHook).toContain('# config=linked-worktree-config')
    expect(linkedHook).not.toContain(canonicalMain)
    expect(existsSync(join(mainHooks, 'pre-merge-commit'))).toBe(true)
    expect(existsSync(join(linkedHooks, 'pre-merge-commit'))).toBe(true)
    expect(readFileSync(legacyHook, 'utf8')).toBe('#!/bin/sh\n# legacy hook\n')

    const commonConfig = join(common, 'config')
    expect(git(fixture, fixture.main, ['config', '--file', commonConfig, '--get', 'core.repositoryFormatVersion'])).toBe('1')
    expect(git(fixture, fixture.main, ['config', '--file', commonConfig, '--get', 'extensions.worktreeConfig'])).toBe('true')
    expect(gitResult(fixture, fixture.main, ['config', '--file', commonConfig, '--get', 'core.bare']).status).toBe(1)

    const mainHookBeforeRemoval = readFileSync(join(mainHooks, 'pre-commit'), 'utf8')
    // Windows Git follows the fixture's MOUNT_POINT junctions into their real
    // targets while removing a worktree; unlink them first so the removal
    // cannot delete the repository's scripts/ or tsx package.
    unlinkFixtureLinks(fixture.linked)
    git(fixture, fixture.main, ['worktree', 'remove', '--force', fixture.linked])
    expect(readFileSync(join(mainHooks, 'pre-commit'), 'utf8')).toBe(mainHookBeforeRemoval)
    expect(readFileSync(legacyHook, 'utf8')).toBe('#!/bin/sh\n# legacy hook\n')
  })

  it('replaces the owned hook path Git copies into a newly added worktree', async () => {
    const fixture = createFixture()
    const mainInstall = await runInstaller(fixture, fixture.main)
    expect(mainInstall.status, mainInstall.stderr).toBe(0)
    const mainHooks = hooksPath(fixture, fixture.main)
    const mainHookBefore = readFileSync(join(mainHooks, 'pre-commit'), 'utf8')
    const lateLinked = join(fixture.container, 'late-linked')
    git(fixture, fixture.main, ['worktree', 'add', '-b', 'late-linked', lateLinked])
    write(join(lateLinked, 'lefthook.yml'), 'late-linked-worktree-config\n')
    installFakeLefthook(lateLinked)
    installPairingProbeFixture(lateLinked)
    expect(git(fixture, lateLinked, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe(mainHooks)

    const linkedInstall = await runInstaller(fixture, lateLinked)

    expect(linkedInstall.status, linkedInstall.stderr).toBe(0)
    const linkedHooks = hooksPath(fixture, lateLinked)
    expect(linkedHooks).not.toBe(mainHooks)
    expect(git(fixture, lateLinked, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe(linkedHooks)
    expect(readFileSync(join(linkedHooks, 'pre-commit'), 'utf8')).toContain(
      '# config=late-linked-worktree-config',
    )
    expect(readFileSync(join(mainHooks, 'pre-commit'), 'utf8')).toBe(mainHookBefore)
  })

  it('serializes concurrent installs and keeps repeated output stable', async () => {
    const fixture = createFixture()
    const delayed = { DSH_TEST_LEFTHOOK_DELAY_MS: '150' }
    const first = await Promise.all([
      runInstaller(fixture, fixture.main, delayed),
      runInstaller(fixture, fixture.linked, delayed),
    ])
    for (const result of first) expect(result.status, result.stderr).toBe(0)

    const mainHookPath = join(hooksPath(fixture, fixture.main), 'pre-push')
    const initialHook = readFileSync(mainHookPath, 'utf8')
    const repeated = await Promise.all([
      runInstaller(fixture, fixture.main, delayed),
      runInstaller(fixture, fixture.main, delayed),
    ])
    for (const result of repeated) expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(mainHookPath, 'utf8')).toBe(initialHook)
    expect(existsSync(join(commonDirectory(fixture), 'dsh-lefthook-install.lock'))).toBe(false)
    expect(existsSync(join(hooksPath(fixture, fixture.main), '.fake-lefthook-running'))).toBe(false)
  })

  it('waits for a concurrent installer to finish publishing its lock record', async () => {
    const fixture = createFixture()
    const lockPath = installLockPath(fixture)
    const publishing = runInstaller(fixture, fixture.main, {
      DSH_TEST_LEFTHOOK_LOCK_WRITE_DELAY_MS: '200',
    })
    await waitForPath(lockPath)
    expect(readFileSync(lockPath, 'utf8')).toBe('')

    const waiting = runInstaller(fixture, fixture.linked)
    const results = await Promise.all([publishing, waiting])

    for (const result of results) expect(result.status, result.stderr).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('repairs its owned absolute hook path after the checkout moves', async () => {
    const fixture = createFixture()
    const oldRoot = fixture.main
    const first = await runInstaller(fixture, oldRoot)
    expect(first.status, first.stderr).toBe(0)
    const oldHooks = hooksPath(fixture, oldRoot)
    const movedRoot = join(fixture.container, 'moved-main')
    renameSync(oldRoot, movedRoot)

    const moved = await runInstaller(fixture, movedRoot)

    expect(moved.status, moved.stderr).toBe(0)
    const movedHooks = hooksPath(fixture, movedRoot)
    expect(movedHooks).not.toBe(oldHooks)
    expect(git(fixture, movedRoot, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe(movedHooks)
    const canonicalMoved = git(fixture, movedRoot, ['rev-parse', '--show-toplevel'])
    expect(readFileSync(join(movedHooks, 'pre-commit'), 'utf8')).toContain(`# root=${canonicalMoved}`)
    expect(readFileSync(join(movedHooks, '.dsh-lefthook-owned'), 'utf8')).toContain(
      JSON.stringify(movedHooks),
    )
  })

  it.skipIf(process.platform === 'win32')('refuses a multiply linked ownership marker before relocation rewrites it', async () => {
    const fixture = createFixture()
    const oldRoot = fixture.main
    const first = await runInstaller(fixture, oldRoot)
    expect(first.status, first.stderr).toBe(0)
    const oldHooks = hooksPath(fixture, oldRoot)
    const markerName = '.dsh-lefthook-owned'
    const externalMarker = join(fixture.container, 'external-marker')
    linkSync(join(oldHooks, markerName), externalMarker)
    const externalContent = readFileSync(externalMarker, 'utf8')
    const movedRoot = join(fixture.container, 'moved-main')
    renameSync(oldRoot, movedRoot)

    const result = await runInstaller(fixture, movedRoot)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('invalid ownership marker')
    expect(readFileSync(externalMarker, 'utf8')).toBe(externalContent)
  })

  it.skipIf(process.platform === 'win32')('refuses aliased generated hooks before Lefthook can overwrite their targets', async () => {
    for (const kind of ['symlink', 'hardlink'] as const) {
      const fixture = createFixture()
      const first = await runInstaller(fixture, fixture.main)
      expect(first.status, first.stderr).toBe(0)
      const hook = join(hooksPath(fixture, fixture.main), 'pre-commit')
      const externalHook = join(fixture.container, `${kind}-external-hook`)
      rmSync(hook)
      write(externalHook, `external ${kind} target\n`)
      if (kind === 'symlink') symlinkSync(externalHook, hook)
      else linkSync(externalHook, hook)
      const externalContent = readFileSync(externalHook, 'utf8')

      const result = await runInstaller(fixture, fixture.main)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('non-regular or multiply linked hook entry')
      expect(readFileSync(externalHook, 'utf8')).toBe(externalContent)
    }
  })

  it('restores the marker-backed stale hook path when relocation reinstall fails', async () => {
    const fixture = createFixture()
    const oldRoot = fixture.main
    const first = await runInstaller(fixture, oldRoot)
    expect(first.status, first.stderr).toBe(0)
    const oldHooks = hooksPath(fixture, oldRoot)
    const markerName = '.dsh-lefthook-owned'
    const previousMarker = readFileSync(join(oldHooks, markerName), 'utf8')
    const movedRoot = join(fixture.container, 'moved-main')
    renameSync(oldRoot, movedRoot)

    const failed = await runInstaller(fixture, movedRoot, { DSH_TEST_LEFTHOOK_FAIL: '1' })

    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('exit status 77')
    const movedHooks = hooksPath(fixture, movedRoot)
    expect(git(fixture, movedRoot, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe(oldHooks)
    expect(readFileSync(join(movedHooks, markerName), 'utf8')).toBe(previousMarker)
  })

  it('refuses dormant repository extensions before upgrading the repository format', async () => {
    const fixture = createFixture()
    const commonConfig = join(commonDirectory(fixture), 'config')
    git(fixture, fixture.main, ['config', 'extensions.dshUnknown', 'true'])
    expect(gitResult(fixture, fixture.main, ['status', '--porcelain']).status).toBe(0)

    const result = await runInstaller(fixture, fixture.main)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('dormant repository extension extensions.dshunknown')
    expect(git(fixture, fixture.main, [
      'config', '--file', commonConfig, '--get', 'core.repositoryFormatVersion',
    ])).toBe('0')
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'extensions.worktreeConfig']).status).toBe(1)
    expect(gitResult(fixture, fixture.main, ['status', '--porcelain']).status).toBe(0)
    expect(existsSync(hooksPath(fixture, fixture.main))).toBe(false)
  })

  it('refuses direct core.worktree before enabling worktree config', async () => {
    const fixture = createFixture()
    const commonConfig = join(commonDirectory(fixture), 'config')
    git(fixture, fixture.main, ['config', '--file', commonConfig, 'core.worktree', fixture.main])

    const result = await runInstaller(fixture, fixture.linked)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('core.worktree is in the common config')
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'extensions.worktreeConfig']).status).toBe(1)
    expect(existsSync(hooksPath(fixture, fixture.main))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('refuses a symlinked common repository config before writing through it', async () => {
    const fixture = createFixture()
    const commonConfig = join(commonDirectory(fixture), 'config')
    const externalConfig = join(fixture.container, 'external-common.gitconfig')
    renameSync(commonConfig, externalConfig)
    symlinkSync(externalConfig, commonConfig)
    const externalContent = readFileSync(externalConfig, 'utf8')

    const result = await runInstaller(fixture, fixture.main)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('common repository config')
    expect(result.stderr).toContain('not a regular file')
    expect(lstatSync(commonConfig).isSymbolicLink()).toBe(true)
    expect(readFileSync(externalConfig, 'utf8')).toBe(externalContent)
    expect(existsSync(hooksPath(fixture, fixture.main))).toBe(false)
  })

  it('leaves stale installer locks for explicit recovery', async () => {
    const fixture = createFixture()
    const lockPath = installLockPath(fixture)
    const completed = spawnSync(process.execPath, ['-e', ''])
    expect(completed.status).toBe(0)
    const staleRecord = `${String(completed.pid)} 00000000-0000-4000-8000-000000000000\n`
    writeFileSync(lockPath, staleRecord)

    const results = await Promise.all(Array.from(
      { length: 4 },
      () => runInstaller(fixture, fixture.main),
    ))

    for (const result of results) {
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('stale Lefthook installer lock')
      expect(result.stderr).toContain('remove it manually')
    }
    expect(readFileSync(lockPath, 'utf8')).toBe(staleRecord)
    expect(existsSync(hooksPath(fixture, fixture.main))).toBe(false)
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'extensions.worktreeConfig']).status).toBe(1)
  })

  it('leaves invalid installer locks for explicit recovery', async () => {
    const fixture = createFixture()
    const lockPath = installLockPath(fixture)
    const invalidRecord = 'not an installer lock\n'
    writeFileSync(lockPath, invalidRecord)

    const result = await runInstaller(fixture, fixture.main)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('invalid Lefthook installer lock')
    expect(result.stderr).toContain('remove it manually')
    expect(readFileSync(lockPath, 'utf8')).toBe(invalidRecord)
    expect(existsSync(hooksPath(fixture, fixture.main))).toBe(false)
  })

  it('does not release an installer lock whose ownership changed', async () => {
    const fixture = createFixture()
    const lockPath = installLockPath(fixture)
    // The fake child replaces the record while the installer holds the lock.
    const result = await runInstaller(fixture, fixture.main, {
      DSH_TEST_LEFTHOOK_REPLACE_LOCK_PATH: lockPath,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('installer lock ownership changed')
    expect(readFileSync(lockPath, 'utf8')).toBe('replacement owner\n')
  })

  it.skipIf(process.platform === 'win32')('preserves trailing spaces in worktree paths', async () => {
    const fixture = createFixture({ main: 'main ', linked: 'linked ' })

    for (const root of [fixture.main, fixture.linked]) {
      const result = await runInstaller(fixture, root)
      expect(result.status, result.stderr).toBe(0)
      expect(git(fixture, root, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe(hooksPath(fixture, root))
    }
  })

  it('preserves user-owned hook paths unless an inherited value is explicitly overridden', async () => {
    const fixture = createFixture()
    const customHook = join(fixture.main, 'custom-hooks/pre-commit')
    write(customHook, '#!/bin/sh\n# custom hook\n', 0o755)
    git(fixture, fixture.main, ['config', 'core.hooksPath', 'custom-hooks'])

    const refused = await runInstaller(fixture, fixture.main)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('refusing to replace user-owned core.hooksPath')
    expect(refused.stderr).toContain('DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE=1')
    expect(git(fixture, fixture.main, ['config', '--get', 'core.hooksPath'])).toBe('custom-hooks')
    expect(readFileSync(customHook, 'utf8')).toBe('#!/bin/sh\n# custom hook\n')
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'extensions.worktreeConfig']).status).toBe(1)

    const optedIn = await runInstaller(fixture, fixture.main, {
      DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE: '1',
    })
    expect(optedIn.status, optedIn.stderr).toBe(0)
    expect(git(fixture, fixture.main, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe(hooksPath(fixture, fixture.main))
    expect(git(fixture, fixture.linked, ['config', '--get', 'core.hooksPath'])).toBe('custom-hooks')
    expect(gitResult(fixture, fixture.linked, ['config', '--worktree', '--get', 'core.hooksPath']).status).toBe(1)
    expect(readFileSync(customHook, 'utf8')).toBe('#!/bin/sh\n# custom hook\n')

    git(fixture, fixture.linked, ['config', '--worktree', 'core.hooksPath', 'linked-custom-hooks'])
    const explicitWorktreePath = await runInstaller(fixture, fixture.linked, {
      DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE: '1',
    })
    expect(explicitWorktreePath.status).toBe(1)
    expect(git(fixture, fixture.linked, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe('linked-custom-hooks')
  })

  it('does not trust an ownership marker outside a registered worktree hook path', async () => {
    const fixture = createFixture()
    const mainInstall = await runInstaller(fixture, fixture.main)
    expect(mainInstall.status, mainInstall.stderr).toBe(0)
    const externalHooks = join(fixture.container, 'external-owned-hooks')
    write(
      join(externalHooks, '.dsh-lefthook-owned'),
      `${JSON.stringify({
        version: 1,
        owner: 'deepseek-harness worktree-local lefthook hooks',
        hooksPath: externalHooks,
      })}\n`,
      0o600,
    )
    git(fixture, fixture.linked, ['config', '--worktree', 'core.hooksPath', externalHooks])

    const result = await runInstaller(fixture, fixture.linked)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('worktree-scoped core.hooksPath')
    expect(git(fixture, fixture.linked, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe(externalHooks)
    expect(existsSync(hooksPath(fixture, fixture.linked))).toBe(false)
  })

  it('refuses to activate a sibling worktree dormant hook path', async () => {
    const fixture = createFixture()
    const linkedConfig = join(gitDirectory(fixture, fixture.linked), 'config.worktree')
    const linkedHooks = join(fixture.linked, 'custom-hooks')
    git(fixture, fixture.main, ['config', '--file', linkedConfig, 'core.hooksPath', linkedHooks])
    expect(gitResult(fixture, fixture.linked, ['config', '--get', 'core.hooksPath']).status).toBe(1)

    const result = await runInstaller(fixture, fixture.main)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('sibling dormant worktree config')
    expect(result.stderr).toContain(JSON.stringify(linkedConfig))
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'extensions.worktreeConfig']).status).toBe(1)
    expect(gitResult(fixture, fixture.linked, ['config', '--get', 'core.hooksPath']).status).toBe(1)
    expect(git(fixture, fixture.main, ['config', '--file', linkedConfig, '--get', 'core.hooksPath'])).toBe(linkedHooks)
    expect(existsSync(hooksPath(fixture, fixture.main))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('refuses an active symlinked worktree config before writing through it', async () => {
    const fixture = createFixture()
    const commonConfig = join(commonDirectory(fixture), 'config')
    const worktreeConfig = join(gitDirectory(fixture, fixture.main), 'config.worktree')
    const externalConfig = join(fixture.container, 'external.gitconfig')
    const externalContent = '[user]\n\tname = External owner\n'
    write(externalConfig, externalContent)
    git(fixture, fixture.main, ['config', '--file', commonConfig, 'core.repositoryFormatVersion', '1'])
    git(fixture, fixture.main, ['config', '--file', commonConfig, 'extensions.worktreeConfig', 'true'])
    symlinkSync(externalConfig, worktreeConfig)

    const result = await runInstaller(fixture, fixture.main)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('active worktree config')
    expect(result.stderr).toContain('not a regular file')
    expect(lstatSync(worktreeConfig).isSymbolicLink()).toBe(true)
    expect(readFileSync(externalConfig, 'utf8')).toBe(externalContent)
    expect(gitResult(fixture, fixture.main, [
      'config', '--file', externalConfig, '--get', 'core.hooksPath',
    ]).status).toBe(1)
    expect(existsSync(hooksPath(fixture, fixture.main))).toBe(false)
  })

  for (const includeKey of ['include.path', 'includeIf.onbranch:conditional.path']) {
    for (const key of ['core.worktree', 'core.bare', 'extensions.dshunknown']) {
      it(`ignores ${key} loaded through ${includeKey}`, async () => {
        const fixture = createFixture()
        const commonConfig = join(commonDirectory(fixture), 'config')
        const includedConfig = join(fixture.container, `${includeKey.split('.')[0]}-${key.replace('.', '-')}.gitconfig`)
        const value = key === 'core.worktree' ? fixture.main : 'true'
        git(fixture, fixture.main, ['config', '--file', includedConfig, key, value])
        git(fixture, fixture.main, ['config', '--file', commonConfig, includeKey, includedConfig])

        const result = await runInstaller(fixture, fixture.linked)

        expect(result.status, result.stderr).toBe(0)
        expect(git(fixture, fixture.linked, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe(
          hooksPath(fixture, fixture.linked),
        )
        expect(existsSync(join(hooksPath(fixture, fixture.linked), 'pre-commit'))).toBe(true)
      })
    }
  }

  it('ignores an inactive global includeIf that provides a hook path for another repository', async () => {
    const fixture = createFixture()
    const globalConfig = fixture.env.GIT_CONFIG_GLOBAL
    if (globalConfig === undefined) throw new Error('fixture global config path is missing')
    const includedConfig = join(fixture.container, 'other-repository.gitconfig')
    const includedHooks = join(fixture.container, 'other-repository-hooks')
    git(fixture, fixture.main, ['config', '--file', includedConfig, 'core.hooksPath', includedHooks])
    git(fixture, fixture.main, [
      'config',
      '--file',
      globalConfig,
      `includeIf.gitdir:${join(fixture.container, 'other')}/.path`,
      includedConfig,
    ])

    const result = await runInstaller(fixture, fixture.linked)

    expect(result.status, result.stderr).toBe(0)
    expect(git(fixture, fixture.linked, ['config', '--get', 'core.hooksPath'])).toBe(hooksPath(fixture, fixture.linked))
  })

  it('never overrides a command-scoped hook path', async () => {
    const fixture = createFixture()
    const commandHooks = join(fixture.container, 'command-hooks')
    const sentinel = join(commandHooks, 'pre-commit')
    write(sentinel, '#!/bin/sh\n# command-scope sentinel\n', 0o755)

    const result = await runInstaller(fixture, fixture.main, {
      DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: commandHooks,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('command-scoped core.hooksPath')
    expect(readFileSync(sentinel, 'utf8')).toBe('#!/bin/sh\n# command-scope sentinel\n')
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'core.hooksPath']).status).toBe(1)
    expect(gitResult(fixture, fixture.main, [
      'config', '--get', 'merge.dsh-translation-pairing.driver',
    ]).status).toBe(1)
    expect(existsSync(hooksPath(fixture, fixture.main))).toBe(false)
  })

  it('never replaces a custom worktree pairing merge driver', async () => {
    const fixture = createFixture()
    const commonConfig = join(commonDirectory(fixture), 'config')
    git(fixture, fixture.main, ['config', '--file', commonConfig, 'core.repositoryFormatVersion', '1'])
    git(fixture, fixture.main, ['config', '--file', commonConfig, 'extensions.worktreeConfig', 'true'])
    git(fixture, fixture.main, [
      'config', '--worktree', 'merge.dsh-translation-pairing.driver', 'custom-driver %A',
    ])

    const result = await runInstaller(fixture, fixture.main)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to replace worktree merge.dsh-translation-pairing.driver')
    expect(git(fixture, fixture.main, [
      'config', '--worktree', '--get', 'merge.dsh-translation-pairing.driver',
    ])).toBe('custom-driver %A')
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'core.hooksPath']).status).toBe(1)
  })

  it('never masks an inherited custom pairing merge driver', async () => {
    const fixture = createFixture()
    git(fixture, fixture.main, [
      'config', '--local', 'merge.dsh-translation-pairing.driver', 'inherited-driver %A',
    ])

    const result = await runInstaller(fixture, fixture.main)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to mask inherited merge.dsh-translation-pairing.driver')
    expect(git(fixture, fixture.main, [
      'config', '--local', '--get', 'merge.dsh-translation-pairing.driver',
    ])).toBe('inherited-driver %A')
    expect(gitResult(fixture, fixture.main, [
      'config', '--worktree', '--get', 'merge.dsh-translation-pairing.driver',
    ]).status).toBe(1)
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'core.hooksPath']).status).toBe(1)
  })

  it('does not pass unrelated command-scoped Git config to Lefthook', async () => {
    const fixture = createFixture()

    const result = await runInstaller(fixture, fixture.main, {
      DSH_TEST_FORBIDDEN_GIT_CONFIG_KEY: 'dsh.testSentinel',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'dsh.testSentinel',
      GIT_CONFIG_VALUE_0: 'must-not-reach-lefthook',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(hooksPath(fixture, fixture.main), 'pre-commit'))).toBe(true)
  })

  it('never overrides a hook path included by worktree config', async () => {
    const fixture = createFixture()
    const commonConfig = join(commonDirectory(fixture), 'config')
    const worktreeConfig = join(gitDirectory(fixture, fixture.main), 'config.worktree')
    const includedConfig = join(fixture.container, 'included-worktree.gitconfig')
    const includedHooks = join(fixture.container, 'included-hooks')
    const sentinel = join(includedHooks, 'pre-commit')
    write(sentinel, '#!/bin/sh\n# included-worktree sentinel\n', 0o755)
    git(fixture, fixture.main, ['config', '--file', includedConfig, 'core.hooksPath', includedHooks])
    git(fixture, fixture.main, ['config', '--file', commonConfig, 'core.repositoryFormatVersion', '1'])
    git(fixture, fixture.main, ['config', '--file', commonConfig, 'extensions.worktreeConfig', 'true'])
    git(fixture, fixture.main, ['config', '--file', worktreeConfig, 'include.path', includedConfig])

    const result = await runInstaller(fixture, fixture.main, {
      DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE: '1',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('worktree-scoped core.hooksPath')
    expect(git(fixture, fixture.main, ['config', '--get', 'core.hooksPath'])).toBe(includedHooks)
    expect(readFileSync(sentinel, 'utf8')).toBe('#!/bin/sh\n# included-worktree sentinel\n')
    expect(existsSync(hooksPath(fixture, fixture.main))).toBe(false)
  })

  it('restores the previous hook lookup when Lefthook installation fails', async () => {
    const fixture = createFixture()
    const common = commonDirectory(fixture)
    const legacyHook = join(common, 'hooks/pre-push')
    write(legacyHook, '#!/bin/sh\n# legacy pre-push\n', 0o755)

    const result = await runInstaller(fixture, fixture.main, { DSH_TEST_LEFTHOOK_FAIL: '1' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('exit status 77')
    expect(gitResult(fixture, fixture.main, ['config', '--worktree', '--get', 'core.hooksPath']).status).toBe(1)
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'core.hooksPath']).status).toBe(1)
    expect(gitResult(fixture, fixture.main, [
      'config', '--worktree', '--get', 'merge.dsh-translation-pairing.name',
    ]).status).toBe(1)
    expect(gitResult(fixture, fixture.main, [
      'config', '--worktree', '--get', 'merge.dsh-translation-pairing.driver',
    ]).status).toBe(1)
    expect(readFileSync(legacyHook, 'utf8')).toBe('#!/bin/sh\n# legacy pre-push\n')
  })

  it('does not publish worktree integration when the pairing driver probe fails', async () => {
    const fixture = createFixture()
    rmSync(join(fixture.main, 'node_modules/tsx'), { recursive: true, force: true })

    const result = await runInstaller(fixture, fixture.main)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('merge-translation-pairing.ts --probe failed')
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'core.hooksPath']).status).toBe(1)
    expect(gitResult(fixture, fixture.main, [
      'config', '--get', 'merge.dsh-translation-pairing.driver',
    ]).status).toBe(1)
  })

  it('reports installation and hook-path rollback failures together', async () => {
    const fixture = createFixture()

    const result = await runInstaller(fixture, fixture.main, {
      DSH_TEST_LEFTHOOK_BREAK_WORKTREE_CONFIG: '1',
      DSH_TEST_LEFTHOOK_FAIL: '1',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Lefthook installation failed')
    expect(result.stderr).toContain('exit status 77')
    expect(result.stderr).toContain('worktree integration rollback also failed')
    expect(result.stderr).toContain('git config --worktree --unset-all core.hooksPath failed')
    expect(result.stderr).toContain('git config --worktree --unset-all merge.dsh-translation-pairing.driver failed')
  })

  it('refuses an unowned directory at the reserved worktree hook path', async () => {
    const fixture = createFixture()
    const reservedHook = join(hooksPath(fixture, fixture.main), 'pre-commit')
    write(reservedHook, '#!/bin/sh\n# user content\n', 0o755)

    const result = await runInstaller(fixture, fixture.main)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to overwrite unowned hooks directory')
    expect(readFileSync(reservedHook, 'utf8')).toBe('#!/bin/sh\n# user content\n')
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'extensions.worktreeConfig']).status).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('rejects Git without config-scope support before mutation', async () => {
    const fixture = createFixture()
    const realGit = commandResult('which', ['git'], fixture.main, fixture.env).stdout.trim()
    const fakeBin = join(fixture.container, 'fake-bin')
    const fakeGit = join(fakeBin, 'git')
    write(
      fakeGit,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.25.0"; exit 0; fi\nexec "${realGit}" "$@"\n`,
      0o755,
    )

    const result = await runInstaller(fixture, fixture.main, {
      PATH: `${fakeBin}:${fixture.env.PATH ?? ''}`,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Git 2.26 or newer is required')
    expect(gitResult(fixture, fixture.main, ['config', '--get', 'extensions.worktreeConfig']).status).toBe(1)
    expect(existsSync(hooksPath(fixture, fixture.main))).toBe(false)
  })
})


describe('real Git hooks at root and nested PC packages', { timeout: 90_000 }, () => {
  for (const { prefix, linked } of [
    { prefix: '', linked: false },
    { prefix: '源码/Mac PC', linked: false },
    { prefix: '源码/Mac PC', linked: true },
  ]) {
    it(`keeps commit --only's selected index at ${prefix || 'root'}${linked ? ' linked worktree' : ''}`, () => {
      let fixture = realFixture(prefix)
      if (linked) {
        const worktree = join(fixture.container, 'linked worktree')
        git(fixture, fixture.main, ['worktree', 'add', '-b', 'only-linked', worktree])
        const project = join(worktree, prefix)
        if (!existsSync(join(project, 'node_modules'))) {
          symlinkSync(resolve(scriptsDirectory, '../node_modules'), join(project, 'node_modules'),
            process.platform === 'win32' ? 'junction' : 'dir')
        }
        fixture = { ...fixture, main: worktree, linked: worktree, project }
      }
      const capture = join(fixture.project, 'capture.mjs')
      write(capture, readFileSync(capture, 'utf8')
        + 'writeFileSync("index-env.json",JSON.stringify({index:process.env.GIT_INDEX_FILE,'
        + 'workTree:process.env.GIT_WORK_TREE,cwd:process.cwd()}))\n')
      expect(installReal(fixture).status).toBe(0)
      const hook = join(hooksPath(fixture, fixture.main), 'pre-commit')
      const indexWitness = join(fixture.container, 'hook-index.txt')
      write(hook, readFileSync(hook, 'utf8').replace('#!/bin/sh\n',
        `#!/bin/sh\nprintf '%s\\n' "$GIT_INDEX_FILE" "$PWD" "$GIT_DIR" "$GIT_WORK_TREE" "$GIT_PREFIX" > '${indexWitness}'\n`),
      0o755)
      const path = (value: string) => prefix === '' ? value : `${prefix}/${value}`
      write(join(fixture.main, 'outside.ts'), 'unrelated staged bytes\n')
      git(fixture, fixture.main, ['add', 'outside.ts'])
      const unrelated = git(fixture, fixture.main, ['ls-files', '--stage', '--', 'outside.ts'])
      const outsideHead = git(fixture, fixture.main, ['show', 'HEAD:outside.ts'])
      writeRealPair(fixture.project, 'Only selected')
      write(join(fixture.project, 'src/中文 file.ts'), 'export const value = 3\n')
      const selected = ['docs/pair.md', 'docs/pair.zh.md', 'docs/pair.i18n.yaml', 'src/中文 file.ts'].map(path)
      const pathspec = join(fixture.container, 'only-paths.nul')
      write(pathspec, selected.join('\0') + '\0')
      const commit = ['commit', '--only', `--pathspec-from-file=${pathspec}`, '--pathspec-file-nul', '-m']
      const positive = gitResult(fixture, fixture.container, ['-C', fixture.main, ...commit, 'selected index'])
      expect(positive.status, positive.stdout + positive.stderr + readFileSync(indexWitness, 'utf8')
        + readFileSync(join(fixture.project, 'index-env.json'), 'utf8')).toBe(0)
      const selectedIndex = readFileSync(indexWitness, 'utf8').split('\n')[0]
      const observed = JSON.parse(readFileSync(join(fixture.project, 'index-env.json'), 'utf8')) as {
        index: string
        workTree?: string
      }
      expect(observed.index).toBe(selectedIndex)
      expect(isAbsolute(observed.index)).toBe(true)
      if (prefix !== '') expect(observed.workTree).toBe(fixture.main)
      expect(git(fixture, fixture.main, ['show', `HEAD:${path('src/中文 file.ts')}`])).toContain('// fixed')
      expect(git(fixture, fixture.main, ['show', 'HEAD:outside.ts'])).toBe(outsideHead)
      expect(git(fixture, fixture.main, ['ls-files', '--stage', '--', 'outside.ts'])).toBe(unrelated)
      const head = git(fixture, fixture.main, ['rev-parse', 'HEAD'])
      writeRealPair(fixture.project, 'Unconfirmed selected')
      write(join(fixture.project, 'docs/pair.i18n.yaml'), 'pair.md: ' + '0'.repeat(40) + '\n'
        + 'pair.zh.md: ' + '0'.repeat(40) + '\n')
      const refused = gitResult(fixture, fixture.container,
        ['-C', fixture.main, ...commit, 'reject unconfirmed selected pair'])
      expect(refused.status).not.toBe(0)
      expect(refused.stdout + refused.stderr).toContain('verify-translation-pairing:')
      expect(git(fixture, fixture.main, ['rev-parse', 'HEAD'])).toBe(head)
      expect(git(fixture, fixture.main, ['ls-files', '--stage', '--', 'outside.ts'])).toBe(unrelated)
    })
  }

  for (const prefix of ['', '源码/Mac PC']) {
    it(`runs commit, merge and push checks with actual index paths at ${prefix || 'root'}`, () => {
      const fixture = realFixture(prefix)
      const path = (value: string) => prefix === '' ? value : `${prefix}/${value}`
      const shared = join(gitDirectory(fixture, fixture.main), 'hooks/pre-commit')
      write(shared, '#!/bin/sh\nexit 41\n', 0o755)
      const sharedBefore = readFileSync(shared)
      const installed = installReal(fixture)
      expect(installed.status, installed.stderr).toBe(0)
      write(join(fixture.project, 'src/中文 file.ts'), 'export const value = 2\n')
      writeRealPair(fixture.project, 'Staged')
      write(join(fixture.project, '.agents/notes/archived/old.i18n.yaml'), 'fixture: staged\n')
      write(join(fixture.main, 'outside.ts'), 'outside staged\n')
      git(fixture, fixture.main, ['add', path('src/中文 file.ts'), path('docs/pair.md'), path('docs/pair.zh.md'),
        path('docs/pair.i18n.yaml'),
        path('.agents/notes/archived/old.i18n.yaml'), 'outside.ts'])
      git(fixture, fixture.main, ['commit', '-m', 'staged hooks'])
      expect(git(fixture, fixture.main, ['show', `HEAD:${path('src/中文 file.ts')}`])).toContain('// fixed')
      if (prefix !== '') expect(git(fixture, fixture.main, ['show', 'HEAD:outside.ts'])).toBe('outside staged')
      const lint = captured(fixture).filter(event => event.kind === 'lint')
      expect(lint).toHaveLength(1)
      expect(lint[0]?.cwd).toBe(fixture.project)
      expect(lint[0]?.files).toContain(`${prefix === '' ? '' : './'}src/中文 file.ts`)
      const pairing = captured(fixture).filter(event => event.kind === 'pairing')
      expect(pairing).toHaveLength(1)
      expect(pairing[0]?.files).toEqual([`${prefix === '' ? '' : './'}docs/pair.i18n.yaml`])
      expect(readFileSync(shared)).toEqual(sharedBefore)
      const beforeUnpaired = git(fixture, fixture.main, ['rev-parse', 'HEAD'])
      writeRealPair(fixture.project, 'Unconfirmed')
      write(join(fixture.project, 'docs/pair.i18n.yaml'), 'pair.md: ' + '0'.repeat(40) + '\n'
        + 'pair.zh.md: ' + '0'.repeat(40) + '\n')
      git(fixture, fixture.main, ['add', path('docs/pair.md'), path('docs/pair.zh.md'), path('docs/pair.i18n.yaml')])
      const refusedPair = gitResult(fixture, fixture.main, ['commit', '-m', 'unconfirmed pair'])
      expect(refusedPair.status).not.toBe(0)
      expect(refusedPair.stdout + refusedPair.stderr).toContain('verify-translation-pairing:')
      expect(git(fixture, fixture.main, ['rev-parse', 'HEAD'])).toBe(beforeUnpaired)
      writeRealPair(fixture.project, 'Confirmed')
      git(fixture, fixture.main, ['add', path('docs/pair.md'), path('docs/pair.zh.md'), path('docs/pair.i18n.yaml')])
      git(fixture, fixture.main, ['commit', '-m', 'confirmed pair'])

      write(join(fixture.project, 'vendor/example/src/index.js'), 'module.exports = 1\n')
      git(fixture, fixture.main, ['add', path('vendor/example/src/index.js')])
      const refusedVendor = gitResult(fixture, fixture.main, ['commit', '-m', 'missing vendor manifest'])
      expect(refusedVendor.status).not.toBe(0)
      expect(refusedVendor.stdout + refusedVendor.stderr).toContain('vendored SOURCE changed')
      write(join(fixture.project, 'vendor/README.md'), '# Vendor\n\nLocal modifications: fixture\n')
      git(fixture, fixture.main, ['add', path('vendor/README.md')])
      git(fixture, fixture.main, ['commit', '-m', 'vendor with manifest'])
      git(fixture, fixture.main, ['switch', '-c', 'side'])
      write(join(fixture.project, 'side.txt'), 'side\n')
      git(fixture, fixture.main, ['add', path('side.txt')])
      git(fixture, fixture.main, ['commit', '-m', 'side'])
      git(fixture, fixture.main, ['switch', 'master'])
      write(join(fixture.project, 'main.txt'), 'main\n')
      git(fixture, fixture.main, ['add', path('main.txt')])
      git(fixture, fixture.main, ['commit', '-m', 'main'])
      git(fixture, fixture.main, ['merge', '--no-ff', 'side', '-m', 'merge checks'])
      expect(captured(fixture).some(event => event.kind === 'merge' && event.cwd === fixture.project)).toBe(true)
      const remote = join(fixture.container, 'remote.git')
      git(fixture, fixture.container, ['init', '--bare', remote])
      git(fixture, fixture.main, ['remote', 'add', 'origin', remote])
      git(fixture, fixture.main, ['push', 'origin', 'HEAD:refs/heads/main'])
      expect(captured(fixture).at(-1)).toEqual({ kind: 'typecheck', cwd: fixture.project, files: [] })
      const pushed = git(fixture, fixture.container, ['--git-dir', remote, 'rev-parse', 'refs/heads/main'])
      write(join(fixture.project, 'push.txt'), 'not pushed\n')
      git(fixture, fixture.main, ['add', path('push.txt')])
      git(fixture, fixture.main, ['commit', '-m', 'push refusal'])
      const refusedPush = commandResult('git', ['push', 'origin', 'HEAD:refs/heads/main'], fixture.main,
        { ...fixture.env, DSH_TEST_FAIL_TYPECHECK: '1' })
      expect(refusedPush.status).not.toBe(0)
      expect(git(fixture, fixture.container, ['--git-dir', remote, 'rev-parse', 'refs/heads/main'])).toBe(pushed)
      expect(readFileSync(shared)).toEqual(sharedBefore)
      if (prefix !== '') {
        write(join(fixture.project, 'lefthook.yml'), readFileSync(join(fixture.project, 'lefthook.yml'), 'utf8') + '\n')
        const stale = gitResult(fixture, fixture.main, ['commit', '--allow-empty', '-m', 'stale config'])
        expect(stale.status).not.toBe(0)
        expect(stale.stderr).toContain('PC hook configuration changed')
        expect(installReal(fixture).status).toBe(0)
        git(fixture, fixture.main, ['commit', '--allow-empty', '-m', 'refreshed config'])
      }
    })
  }
})


it('binds a nested installer to its own PC even when the outer product has Lefthook', () => {
  const fixture = realFixture('源码/Mac PC')
  const outerConfig = JSON.stringify({
    'pre-commit': { jobs: [{ name: 'outer product', run: 'exit 41' }] },
    'pre-merge-commit': { jobs: [{ name: 'outer product', run: 'exit 41' }] },
    'pre-push': { jobs: [{ name: 'outer product', run: 'exit 41' }] },
  })
  write(join(fixture.main, 'lefthook.yml'), outerConfig)
  symlinkSync(resolve(scriptsDirectory, '../node_modules'), join(fixture.main, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir')
  const result = installReal(fixture)
  expect(result.status, result.stderr).toBe(0)
  const generated = JSON.parse(readFileSync(join(hooksPath(fixture, fixture.main), 'lefthook.json'), 'utf8')) as {
    'pre-push': { jobs: { name: string; root: string; run: string }[] }
  }
  expect(generated['pre-push'].jobs).toEqual([{
    name: 'typecheck', root: '源码/Mac PC/', run: 'pnpm run typecheck',
  }])
  writeRealPair(fixture.project, 'Actual PC')
  git(fixture, fixture.main, ['add', '源码/Mac PC/docs'])
  git(fixture, fixture.main, ['commit', '-m', 'PC own checks'])
  expect(captured(fixture).every(event => event.cwd === fixture.project)).toBe(true)
  expect(readFileSync(join(fixture.main, 'lefthook.yml'), 'utf8')).toBe(outerConfig)
}, 90_000)


it('preserves every installed nested hook when a replacement write fails after partial bytes', () => {
  const fixture = realFixture('源码/Mac PC')
  expect(installReal(fixture).status).toBe(0)
  const ownHooks = hooksPath(fixture, fixture.main)
  const names = ['pre-commit', 'pre-merge-commit', 'pre-push', 'lefthook.json', 'lefthook-settings.json']
  const before = new Map(names.map(name => [name, readFileSync(join(ownHooks, name))]))
  const config = readFileSync(join(fixture.project, 'lefthook.yml'), 'utf8')
  write(join(fixture.project, 'lefthook.yml'), config + '\n')
  const fault = join(fixture.container, 'partial-write-fault.mjs')
  write(fault, `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const open = fs.openSync
const write = fs.writeFileSync
const prepared = new Set()
let injected = false
fs.openSync = (...args) => {
  const fd = open(...args)
  if (typeof args[0] === 'string' && args[0].replaceAll('\\\\', '/').includes('/.dsh-hook-write-')) prepared.add(fd)
  return fd
}
fs.writeFileSync = (target, bytes, ...args) => {
  if (!injected && prepared.has(target) && String(bytes).includes('--run-hook pre-push')) {
    injected = true
    write(target, Buffer.from(bytes).subarray(0, 12), ...args)
    throw Object.assign(new Error('injected partial hook write'), {code:'EIO'})
  }
  return write(target, bytes, ...args)
}
syncBuiltinESMExports()
`)
  const failed = commandResult(process.execPath,
    ['--import', fault, join(fixture.project, 'scripts/install-lefthook.mjs')], fixture.project, fixture.env)
  expect(failed.status).not.toBe(0)
  expect(failed.stderr).toContain('injected partial hook write')
  for (const name of names) expect(readFileSync(join(ownHooks, name))).toEqual(before.get(name))
  expect(git(fixture, fixture.main, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe(ownHooks)
  expect(readdirSync(ownHooks).some(name => name.startsWith('.dsh-hook-write-'))).toBe(false)
  write(join(fixture.project, 'lefthook.yml'), config)
  writeRealPair(fixture.project, 'Still checked')
  git(fixture, fixture.main, ['add', '源码/Mac PC/docs'])
  git(fixture, fixture.main, ['commit', '-m', 'old hooks still work'])
  expect(captured(fixture).some(event => event.kind === 'pairing')).toBe(true)
}, 90_000)
