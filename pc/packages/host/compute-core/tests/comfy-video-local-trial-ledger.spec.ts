import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { link, lstat, mkdir, mkdtemp, realpath, stat, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ComfyVideoLocalTrialLedger, provisionComfyVideoLocalTrialLedger,
  type ComfyVideoLocalTrialBinding } from '../src/comfy-video-local-trial-ledger.ts'

const enabled = process.platform === 'win32' && Boolean(process.env.QIANSHOU_WINDOWS_NTFS_TEST_ROOT)
const source = new URL('../src/comfy-video-local-trial-ledger.ts', import.meta.url).href
const children: ChildProcess[] = []
const servers: Server[] = []

function binding(trialKey = 'owner-video-trial-1', approvalSha256 = 'a'.repeat(64)): ComfyVideoLocalTrialBinding {
  return { ownerId: '167', profileId: 'private-profile-1', trialKey,
    approvalSha256, graphSha256: 'b'.repeat(64),
    contractDigest: `sha256:${'c'.repeat(64)}`, dependencyManifestSha256: 'd'.repeat(64),
    runnerSourceSha256: 'e'.repeat(64), runtimeWitnessSha256: 'f'.repeat(64),
    inputSha256: '1'.repeat(64) }
}

function volumeAt(path: string): { FileSystem: string, DriveType: string, UniqueId: string } {
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$v=Get-Volume -FilePath $env:QIANSHOU_LOCAL_TRIAL_TEST_PARENT -ErrorAction Stop; [pscustomobject]@{FileSystem=$v.FileSystem;DriveType=$v.DriveType.ToString();UniqueId=$v.UniqueId} | ConvertTo-Json -Compress"],
  { encoding: 'utf8', timeout: 15_000, windowsHide: true,
    env: { ...process.env, QIANSHOU_LOCAL_TRIAL_TEST_PARENT: path } }).trim()
  return JSON.parse(raw) as { FileSystem: string, DriveType: string, UniqueId: string }
}

async function trialPath(): Promise<{ path: string, volumeSha256: string }> {
  const configured = process.env.QIANSHOU_WINDOWS_NTFS_TEST_ROOT!
  if (!isAbsolute(configured) || !/^[A-Za-z]:[\\/]/u.test(configured)) throw new Error('An existing fixed NTFS test root is required')
  const parent = await realpath(configured)
  const volume = volumeAt(parent)
  expect(volume.FileSystem).toBe('NTFS')
  expect(volume.DriveType).toBe('Fixed')
  const root = await mkdtemp(join(parent, 'comfy-video-local-trial-'))
  const named = await lstat(root)
  expect(named.isDirectory()).toBe(true)
  expect(named.isSymbolicLink()).toBe(false)
  return { path: join(root, 'private', 'local-trials.sqlite'),
    volumeSha256: createHash('sha256').update(volume.UniqueId).digest('hex') }
}

type Child = { process: ChildProcess, output: () => string, exit: Promise<number | null>, waitFor: (text: string) => Promise<void> }
function runChild(code: string, args: string[]): Child {
  const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', code, ...args],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  children.push(child)
  let output = ''
  let error = ''
  const listeners: Array<() => void> = []
  child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); listeners.forEach(check => check()) })
  child.stderr!.on('data', (chunk: Buffer) => { error += chunk.toString('utf8') })
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code))
  })
  return { process: child, output: () => output, exit,
    waitFor: text => output.includes(text) ? Promise.resolve() : new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child did not print ${text}; ${output}; ${error}`)), 20_000)
      const check = (): void => {
        if (!output.includes(text)) return
        clearTimeout(timer)
        listeners.splice(listeners.indexOf(check), 1)
        resolve()
      }
      listeners.push(check)
      void exit.then(() => { if (!output.includes(text)) { clearTimeout(timer); reject(new Error(`child exited before ${text}; ${error}`)) } })
    }) }
}

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
})

describe.skipIf(!enabled)('owner-local Comfy video ledger on a real Windows NTFS volume', () => {
  it('allows only one first-time provisioner and recovers its distinct WAL database', async () => {
    const { path, volumeSha256 } = await trialPath()
    const code = `const { provisionComfyVideoLocalTrialLedger: provision } = await import(${JSON.stringify(source)});
      try { await provision(process.argv[1]); process.stdout.write('PROVISIONED\\n'); }
      catch { process.stdout.write('REFUSED\\n'); }`
    const first = runChild(code, [path]), second = runChild(code, [path])
    const exits = await Promise.all([first.exit, second.exit])
    expect(exits).toEqual([0, 0])
    expect([first.output(), second.output()].filter(text => text.includes('PROVISIONED'))).toHaveLength(1)
    expect([first.output(), second.output()].filter(text => text.includes('REFUSED'))).toHaveLength(1)
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      expect(Number(db.prepare('PRAGMA application_id').get()?.application_id)).toBe(0x51535654)
      expect(Number(db.prepare('PRAGMA user_version').get()?.user_version)).toBe(1)
      expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
      expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok')
    } finally { db.close() }
    const ledger = new ComfyVideoLocalTrialLedger(path)
    expect(await ledger.recoverAtStartup()).toEqual({ state: 'none', record: null })
    console.info(`LOCAL_TRIAL_NTFS_WITNESS ${JSON.stringify({ case: 'first-create', volumeSha256,
      provisioned: 1, refused: 1, dbBytes: (await stat(path)).size, recovered: 'none' })}`)
  }, 45_000)

  it('keeps an interrupted first setup unavailable and does not recreate history', async () => {
    const { path } = await trialPath()
    await mkdir(join(path, '..'))
    await expect(new ComfyVideoLocalTrialLedger(path).recoverAtStartup())
      .rejects.toMatchObject({ code: 'COMPUTE_COMFY_VIDEO_LOCAL_TRIAL_STORAGE_UNVERIFIED' })
    await expect(provisionComfyVideoLocalTrialLedger(path))
      .rejects.toMatchObject({ code: 'COMPUTE_COMFY_VIDEO_LOCAL_TRIAL_STORAGE_UNVERIFIED' })
  }, 30_000)

  it('rejects a hard-linked database leaf before opening SQLite', async () => {
    const { path } = await trialPath()
    await provisionComfyVideoLocalTrialLedger(path)
    await link(path, join(dirname(dirname(path)), 'second-hardlink.sqlite'))
    await expect(new ComfyVideoLocalTrialLedger(path).recoverAtStartup())
      .rejects.toMatchObject({ code: 'COMPUTE_COMFY_VIDEO_LOCAL_TRIAL_STORAGE_UNVERIFIED' })
  }, 30_000)

  it('rejects a pre-existing parent junction instead of opening its matching database', async ctx => {
    const { path } = await trialPath()
    await provisionComfyVideoLocalTrialLedger(path)
    const linkedParent = join(dirname(dirname(path)), 'linked-private')
    try { await symlink(dirname(path), linkedParent, 'junction') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { ctx.skip(); return }
      throw error
    }
    await expect(new ComfyVideoLocalTrialLedger(join(linkedParent, 'local-trials.sqlite')).recoverAtStartup())
      .rejects.toMatchObject({ code: 'COMPUTE_COMFY_VIDEO_LOCAL_TRIAL_STORAGE_UNVERIFIED' })
  }, 30_000)

  it('commits the sole POST intent before a crash and refuses every later resend', async () => {
    const { path, volumeSha256 } = await trialPath()
    await provisionComfyVideoLocalTrialLedger(path)
    const ledger = new ComfyVideoLocalTrialLedger(path)
    await ledger.recoverAtStartup()
    const reserved = await ledger.reserve(binding())
    let posts = 0
    let seen: () => void = () => {}
    const received = new Promise<void>(resolve => { seen = resolve })
    const server = createServer((_request, _response) => { posts++; seen() })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Loopback server unavailable')
    const code = `const { ComfyVideoLocalTrialLedger: Ledger } = await import(${JSON.stringify(source)});
      const ledger = new Ledger(process.argv[1]); await ledger.recoverAtStartup();
      const reserved = JSON.parse(process.argv[2]); await ledger.beforePromptSubmit(reserved);
      process.stdout.write('INTENT_COMMITTED\\n');
      await fetch('http://127.0.0.1:' + process.argv[3] + '/prompt', { method:'POST', body:'{}' });`
    const child = runChild(code, [path, JSON.stringify(reserved), String(address.port)])
    await child.waitFor('INTENT_COMMITTED')
    await received
    child.process.kill('SIGKILL')
    await child.exit
    const restarted = new ComfyVideoLocalTrialLedger(path)
    expect(await restarted.recoverAtStartup()).toMatchObject({ state: 'unknown', record: { state: 'submitting', promptId: null } })
    await expect(restarted.beforePromptSubmit(reserved))
      .rejects.toMatchObject({ code: 'COMPUTE_COMFY_VIDEO_LOCAL_TRIAL_INVALID' })
    await expect(restarted.reserve(binding('owner-video-trial-2')))
      .rejects.toMatchObject({ code: 'COMPUTE_COMFY_VIDEO_LOCAL_TRIAL_INVALID' })
    expect(posts).toBe(1)
    console.info(`LOCAL_TRIAL_NTFS_WITNESS ${JSON.stringify({ case: 'crash-unknown', volumeSha256,
      pid: child.process.pid, postCount: posts, dbBytes: (await stat(path)).size,
      walExists: await stat(`${path}-wal`).then(() => true, () => false), recovered: 'unknown' })}`)
  }, 45_000)

  it('authorizes only one cross-process reservation and POST intent', async () => {
    const { path, volumeSha256 } = await trialPath()
    await provisionComfyVideoLocalTrialLedger(path)
    const code = `const { ComfyVideoLocalTrialLedger: Ledger } = await import(${JSON.stringify(source)});
      const ledger = new Ledger(process.argv[1]); await ledger.recoverAtStartup();
      process.stdout.write('READY\\n'); await new Promise(resolve => process.stdin.once('data', resolve));
      try { const record = await ledger.reserve(JSON.parse(process.argv[2]));
        await ledger.beforePromptSubmit(record); process.stdout.write('AUTHORIZED\\n'); }
      catch { process.stdout.write('REFUSED\\n'); }`
    const first = runChild(code, [path, JSON.stringify(binding('first'))])
    const second = runChild(code, [path, JSON.stringify(binding('second'))])
    await Promise.all([first.waitFor('READY'), second.waitFor('READY')])
    first.process.stdin!.end('GO\n')
    second.process.stdin!.end('GO\n')
    expect(await Promise.all([first.exit, second.exit])).toEqual([0, 0])
    expect([first.output(), second.output()].filter(text => text.includes('AUTHORIZED'))).toHaveLength(1)
    expect([first.output(), second.output()].filter(text => text.includes('REFUSED'))).toHaveLength(1)
    expect(await new ComfyVideoLocalTrialLedger(path).recoverAtStartup()).toMatchObject({ state: 'unknown' })
    console.info(`LOCAL_TRIAL_NTFS_WITNESS ${JSON.stringify({ case: 'cross-process-reserve', volumeSha256,
      firstPid: first.process.pid, secondPid: second.process.pid, authorized: 1, refused: 1,
      recovered: 'unknown' })}`)
  }, 45_000)

  it('serializes competing owners and preserves a known prompt through WAL/SHM restart', async () => {
    const { path, volumeSha256 } = await trialPath()
    await provisionComfyVideoLocalTrialLedger(path)
    const anchor = new DatabaseSync(path)
    try {
      anchor.exec('PRAGMA journal_mode=WAL; BEGIN')
      anchor.prepare('SELECT count(*) FROM trials').get()
      const first = new ComfyVideoLocalTrialLedger(path)
      const second = new ComfyVideoLocalTrialLedger(path)
      await Promise.all([first.recoverAtStartup(), second.recoverAtStartup()])
      const attempts = await Promise.allSettled([first.reserve(binding('first')), second.reserve(binding('second'))])
      const accepted = attempts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof first.reserve>>> => result.status === 'fulfilled')
      expect(accepted).toHaveLength(1)
      expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1)
      const winner = accepted[0]!.value
      const writer = winner.trialKey === 'first' ? first : second
      await writer.beforePromptSubmit(winner)
      await writer.recordPromptId(winner, 'a7cce3aa-d113-44c5-8bea-647d3aa51b6f')
      const recovered = new ComfyVideoLocalTrialLedger(path)
      expect(await recovered.recoverAtStartup()).toMatchObject({ state: 'unknown', record: {
        state: 'submitted', promptId: 'a7cce3aa-d113-44c5-8bea-647d3aa51b6f' } })
      const wal = await stat(`${path}-wal`)
      const shm = await stat(`${path}-shm`)
      expect(wal.size).toBeGreaterThan(0)
      expect(shm.size).toBeGreaterThan(0)
      console.info(`LOCAL_TRIAL_NTFS_WITNESS ${JSON.stringify({ case: 'wal-restart', volumeSha256,
        reserved: 1, refused: 1, walBytes: wal.size, shmBytes: shm.size, recovered: 'unknown' })}`)
    } finally { anchor.exec('ROLLBACK'); anchor.close() }
  }, 45_000)

  it('permits the next distinct trial only after local completion or safe pre-POST abandonment', async () => {
    const { path } = await trialPath()
    await provisionComfyVideoLocalTrialLedger(path)
    const ledger = new ComfyVideoLocalTrialLedger(path)
    await ledger.recoverAtStartup()
    const first = await ledger.reserve(binding('first'))
    await ledger.abandonReserved(first)
    await expect(ledger.beforePromptSubmit(first)).rejects.toMatchObject({ code: 'COMPUTE_COMFY_VIDEO_LOCAL_TRIAL_INVALID' })
    const second = await ledger.reserve(binding('second', 'b'.repeat(64)))
    await ledger.beforePromptSubmit(second)
    await ledger.recordPromptId(second, '7f6d082a-2cb7-4845-a0c6-2ade70f61ba6')
    await ledger.recordLocalResult(second, '2'.repeat(64))
    expect(await new ComfyVideoLocalTrialLedger(path).recoverAtStartup()).toMatchObject({ state: 'local-verified' })
    await expect(ledger.reserve(binding('second'))).rejects.toMatchObject({ code: 'COMPUTE_COMFY_VIDEO_LOCAL_TRIAL_INVALID' })
    await expect(ledger.reserve(binding('third', 'b'.repeat(64))))
      .rejects.toMatchObject({ code: 'COMPUTE_COMFY_VIDEO_LOCAL_TRIAL_INVALID' })
    expect((await ledger.reserve(binding('third', 'c'.repeat(64)))).state).toBe('reserved')
  }, 45_000)
})
