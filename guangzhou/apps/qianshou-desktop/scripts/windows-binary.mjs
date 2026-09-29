/** Windows PE branding and target-binary checks that do not execute foreign code. */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/** Read the PE machine field; malformed or foreign binary files fail packaging. */
export function requireWindowsX64(bytes, name) {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error(`Not a Windows PE binary: ${name}`)
  const offset = bytes.readUInt32LE(0x3c)
  if (offset > bytes.length - 6 || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error(`Not an AMD64 PE binary: ${name}`)
}

/** Replace only Electron's resource data, preserve every code section, and explicitly produce an unsigned executable. */
export async function brandWindowsExecutable(executable, pngPath, iconPath, version) {
  const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
  const builderRequire = createRequire(desktopRequire.resolve('electron-builder'))
  const resourceRequire = createRequire(builderRequire.resolve('app-builder-lib'))
  const RE = resourceRequire('resedit')
  const PE = resourceRequire('pe-library')
  const sharp = createRequire(new URL('../../../packages/attachment/attachment-local/package.json', import.meta.url))('sharp')
  const original = readFileSync(executable)
  requireWindowsX64(original, 'Electron')
  const exe = PE.NtExecutable.from(original, { ignoreCert: true })
  const sectionHashes = data => new Map(data.getAllSections().filter(section => section.info.name !== '.rsrc').map(section => [section.info.name, digest(Buffer.from(section.data ?? new ArrayBuffer(0)))]))
  const before = sectionHashes(exe)
  const resources = PE.NtExecutableResource.from(exe)
  const icon = new RE.Data.IconFile()
  for (const size of [32, 48, 256]) {
    const png = await sharp(pngPath).resize(size, size).png().toBuffer()
    icon.icons.push({ data: new RE.Data.RawIconItem(png, size, size, 32) })
  }
  const groups = RE.Resource.IconGroupEntry.fromEntries(resources.entries)
  if (groups.length === 0) throw new Error('Electron has no icon resource to replace')
  for (const group of groups) RE.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icon.icons.map(item => item.data))
  const versions = RE.Resource.VersionInfo.fromEntries(resources.entries)
  if (versions.length === 0) throw new Error('Electron has no version resource')
  const [major, minor, patch] = version.split('.').map(Number)
  for (const entry of versions) {
    entry.setFileVersion(major, minor, patch, 0, 1033)
    entry.setProductVersion(major, minor, patch, 0, 1033)
    entry.setStringValues({ lang: 1033, codepage: 1200 }, { FileDescription: '千手智能体', ProductName: '千手智能体', InternalName: 'QianshouAgent', OriginalFilename: 'QianshouAgent.exe' })
    entry.outputToResourceEntries(resources.entries)
  }
  resources.outputResource(exe)
  const branded = Buffer.from(exe.generate())
  requireWindowsX64(branded, 'QianshouAgent.exe')
  const after = sectionHashes(PE.NtExecutable.from(branded))
  if (before.size !== after.size || [...before].some(([name, hash]) => after.get(name) !== hash)) throw new Error('PE branding changed a non-resource section')
  writeFileSync(executable, branded)
  writeFileSync(iconPath, Buffer.from(icon.generate()))
  return { sourceSha256: digest(original), brandedSha256: digest(branded), iconSha256: digest(readFileSync(iconPath)), nonResourceSectionsUnchanged: true, signed: false, resourceEditor: 'resedit 1.7.2 / pe-library 0.4.1' }
}

/** Reject all symlinks and non-Windows native files; return the complete native-file checksum inventory. */
export function auditWindowsFiles(root, { allowedI386Executables = {} } = {}) {
  const binaries = []
  let files = 0
  let longestPath = ''
  const walk = path => {
    const entries = readdirSync(path, { withFileTypes: true })
    const names = new Set()
    for (const entry of entries) {
      const folded = entry.name.toLocaleLowerCase('en-US')
      if (names.has(folded)) throw new Error(`Windows case-insensitive name collision: ${relative(root, path)}/${entry.name}`)
      names.add(folded)
      if (/[<>:"|?*\u0000-\u001f]/u.test(entry.name) || /[. ]$/u.test(entry.name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(entry.name)) throw new Error(`Windows reserved path component: ${entry.name}`)
      const file = join(path, entry.name)
      const relativePath = relative(root, file).replaceAll('\\', '/')
      if (relativePath.length > longestPath.length) longestPath = relativePath
      if (entry.isSymbolicLink()) throw new Error(`Windows archive cannot contain symlinks: ${relative(root, file)}`)
      if (entry.isDirectory()) { walk(file); continue }
      files += 1
      if (/\.(?:node|dll|exe)$/iu.test(entry.name)) {
        const bytes = readFileSync(file)
        const sha256 = digest(bytes)
        const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : bytes.length
        const i386Helper = entry.name.endsWith('.exe') && allowedI386Executables[relativePath] === sha256
          && bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d && offset <= bytes.length - 6
          && bytes.readUInt32LE(offset) === 0x4550 && bytes.readUInt16LE(offset + 4) === 0x14c
        if (!i386Helper) requireWindowsX64(bytes, relative(root, file))
        binaries.push({ path: relativePath, bytes: bytes.length, sha256, machine: i386Helper ? 'I386' : 'AMD64',
          ...(i386Helper ? { compatibility: 'Standalone upstream helper via Windows x64 WOW64; exact path and upstream SHA allow-list' } : {}) })
      }
      if (/\.(?:dylib|so)$/iu.test(entry.name)) throw new Error(`Foreign native library in Windows package: ${relative(root, file)}`)
    }
  }
  walk(root)
  return { files, symlinks: 0, nativeFiles: binaries, nativeExecutionTested: false, windowsNamesChecked: true, maxRelativePathLength: longestPath.length, longestRelativePath: longestPath, shortExtractionDirectoryRecommended: true }
}
