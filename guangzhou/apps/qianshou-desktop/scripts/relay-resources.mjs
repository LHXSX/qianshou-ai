/** Stage public relay modules and one checksum-locked FRP target; never copy enrollment state. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8'))

function verify(bytes, expected, description) {
  if (!/^[a-f0-9]{64}$/u.test(expected) || sha256(bytes) !== expected) throw new Error(`${description} checksum mismatch`)
  return bytes
}

/**
 * Copy maintained relay modules, verified CA certificates and the exact platform executable.
 * @param options - Application source, fresh app/relay destination and target archive cache.
 * @returns The public resource manifest written beside the executable.
 */
export async function stageDesktopRelay({ appRoot, destination, platform, arch, cacheRoot }) {
  const source = join(appRoot, 'relay')
  const lock = json(join(source, 'frpc.lock.json'))
  if (lock.version !== 1 || lock.frpcVersion !== '0.71.0' || !Array.isArray(lock.targets)) throw new Error('Unsupported FRP lock file')
  const targets = lock.targets.filter(row => row.platform === platform && row.arch === arch)
  if (targets.length !== 1) throw new Error(`No unique locked FRP target for ${platform}/${arch}`)
  const target = targets[0]
  const expectedFile = platform === 'win32' ? 'frpc.exe' : 'frpc'
  if (target.binary.file !== expectedFile || lock.ca.file !== 'isrg-roots.pem') throw new Error('Unexpected relay resource filename')
  if (!target.archive.url.startsWith(`https://github.com/fatedier/frp/releases/download/v${lock.frpcVersion}/`)) throw new Error('FRP archive must come from the locked official release')
  const ca = verify(readFileSync(join(source, 'resources', lock.ca.file)), lock.ca.sha256, 'Relay CA')
  mkdirSync(cacheRoot, { recursive: true })
  const archivePath = join(cacheRoot, basename(new URL(target.archive.url).pathname))
  if (!existsSync(archivePath)) {
    const response = await fetch(target.archive.url, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`FRP download returned HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length !== target.archive.bytes) throw new Error('FRP archive byte length mismatch')
    verify(bytes, target.archive.sha256, 'FRP archive')
    writeFileSync(archivePath, bytes, { flag: 'wx' })
  }
  const archive = verify(readFileSync(archivePath), target.archive.sha256, 'FRP archive')
  if (archive.length !== target.archive.bytes) throw new Error('FRP archive byte length mismatch')
  const extract = entry => {
    if (typeof entry !== 'string' || entry.startsWith('/') || entry.split('/').some(part => part === '..')) throw new Error('Invalid locked archive member')
    return archivePath.endsWith('.zip')
      ? execFileSync('python3', ['-c', 'import zipfile,sys; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))', archivePath, entry], { maxBuffer: 64 * 1024 ** 2 })
      : execFileSync('tar', ['-xOf', archivePath, entry], { maxBuffer: 64 * 1024 ** 2 })
  }
  const binary = verify(extract(target.binary.entry), target.binary.sha256, 'FRP executable')
  const license = verify(extract(target.license.entry), target.license.sha256, 'FRP license')
  if (existsSync(destination)) throw new Error('Relay destination already exists; refusing to mix target resources')
  mkdirSync(join(destination, 'resources'), { recursive: true })
  for (const file of readdirSync(source)) {
    const path = join(source, file)
    if (!lstatSync(path).isFile()) continue
    if ((file.endsWith('.mjs') && !/\.(?:test|spec)\.mjs$/u.test(file)) || /^README(?:\.zh)?\.md$/u.test(file) || file === 'frpc.lock.json') {
      copyFileSync(path, join(destination, file))
    }
  }
  const resources = join(destination, 'resources')
  writeFileSync(join(resources, expectedFile), binary, { mode: 0o755 })
  writeFileSync(join(resources, lock.ca.file), ca)
  writeFileSync(join(resources, 'FRP_LICENSE'), license)
  const manifest = { version: 1, frpcVersion: lock.frpcVersion, platform, arch,
    binary: { file: expectedFile, sha256: target.binary.sha256 },
    ca: { file: lock.ca.file, sha256: lock.ca.sha256 } }
  writeFileSync(join(resources, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
