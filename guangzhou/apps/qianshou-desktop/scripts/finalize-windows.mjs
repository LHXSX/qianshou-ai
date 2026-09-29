/** Finalize an already copied Windows distribution; never read a user profile or rebuild its sources. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditWindowsFiles } from './windows-binary.mjs'

export function finalizeWindowsArchive({ output, release, metadata, versions, packages, electronVersion,
  actualElectron, electronArchiveName, branding, allowedI386Executables = {} }) {
  const folderName = `qianshou-agent-${metadata.version}-win32-x64`
  if (existsSync(join(release, `${folderName}.zip`))) throw new Error('Refusing to replace an existing Windows archive')
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const audit = auditWindowsFiles(output, { allowedI386Executables })
  for (const required of ['node.exe', 'conpty.node', 'conpty_console_list.node', 'koffi.node', 'rg.exe']) if (!audit.nativeFiles.some(file => file.path.endsWith(`/${required}`))) throw new Error(`Required Windows binary absent: ${required}`)
  if (!audit.nativeFiles.some(file => file.path.includes('sharp-win32-x64') && file.path.endsWith('.node'))) throw new Error('Windows Sharp binary absent')
  if (!audit.nativeFiles.some(file => file.path.includes('node-addon-require-builtin-win32-x64-msvc') && file.path.endsWith('.node'))) throw new Error('Windows custom Node builtin loader binary absent')
  if (packages.some(pkg => /^@deepseek-ai\/node-addon-system-(?:darwin|linux)-/u.test(pkg.name))) throw new Error('POSIX flock native package leaked into Windows runtime')
  const manifest = { schemaVersion: 1, product: 'qianshou-agent', version: metadata.version, channel: 'preview', platform: 'win32', arch: 'x64', signing: 'unsigned', targetBinaryExecuted: false, targetGUIValidated: false,
    validation: 'PACKAGED_NOT_TARGET_LAUNCH_VALIDATED', electron: { version: electronVersion, upstreamArchiveSha256: actualElectron, url: `https://github.com/electron/electron/releases/download/v${electronVersion}/${electronArchiveName}`, branding }, runtime: versions,
    packageCount: packages.length, dependencyResolutionChecked: true, posixFlockNativeExcludedOnWindows: true,
    includesUserData: false, ...audit }
  writeFileSync(join(output, 'BUILD_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const archive = join(release, `${folderName}.zip`)
  execFileSync('python3', ['-c', 'import pathlib,zipfile,hashlib,sys; root=pathlib.Path(sys.argv[1]); files=sorted(p for p in root.rglob("*") if p.is_file()); index="\\n".join(hashlib.sha256(p.read_bytes()).hexdigest()+"  "+p.relative_to(root).as_posix() for p in files)+"\\n"; (root/"PACKAGE_FILES.sha256").write_text(index); files.append(root/"PACKAGE_FILES.sha256"); z=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED,compresslevel=6); [z.write(p,p.relative_to(root.parent).as_posix()) for p in files]; z.close(); check=zipfile.ZipFile(sys.argv[2]); assert check.testzip() is None', output, archive])
  const archiveInfo = { filename: `${folderName}.zip`, bytes: statSync(archive).size, sha256: digest(readFileSync(archive)), crcVerified: true }
  writeFileSync(`${archive}.sha256`, `${archiveInfo.sha256}  ${archiveInfo.filename}\n`)
  writeFileSync(join(release, 'RELEASE_MANIFEST.json'), `${JSON.stringify({ ...manifest, archive: archiveInfo }, null, 2)}\n`)
  console.log(JSON.stringify({ output, archive: archiveInfo, nativeFiles: audit.nativeFiles.length,
    packageCount: packages.length, validation: manifest.validation }, null, 2))
  return { archive, archiveInfo, manifest }
}
