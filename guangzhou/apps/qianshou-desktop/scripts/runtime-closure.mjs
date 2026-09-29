/** Snapshot the installed production dependency graph without invoking an installer or changing its state. */
import { existsSync, globSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'

/** Copy runtime bytes and executable modes without source filesystem extended attributes or external links. */
export function copyRuntimeTree(source, destination, options = {}) {
  const active = new Set()
  const copy = (from, to) => {
    if (options.filter && !options.filter(from)) return
    const metadata = statSync(from)
    if (metadata.isDirectory()) {
      if (options.target && existsSync(join(from, 'package.json'))) {
        const manifest = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'))
        if (!matchesPlatform(manifest.os, options.target.platform) || !matchesPlatform(manifest.cpu, options.target.arch)) return
      }
      const identity = realpathSync(from)
      if (active.has(identity)) throw new Error(`Cyclic runtime directory link: ${from}`)
      active.add(identity)
      mkdirSync(to, { recursive: true })
      for (const entry of readdirSync(from)) copy(join(from, entry), join(to, entry))
      active.delete(identity)
    } else if (metadata.isFile()) {
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, readFileSync(from), { mode: metadata.mode & 0o777 })
    } else throw new Error(`Unsupported runtime file type: ${from}`)
  }
  copy(source, destination)
}

/** npm OS/CPU selectors permit explicit exclusions as well as an allow-list. */
export function matchesPlatform(values, actual) {
  if (!values) return true
  if (values.includes(`!${actual}`)) return false
  const positive = values.filter(value => !value.startsWith('!'))
  return positive.length === 0 || positive.includes(actual) || positive.includes('any')
}

/** Resolve package directories using Node's ancestor node_modules lookup, including export-hidden manifests. */
export function resolveInstalledPackage(name, from) {
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu.test(name)) throw new Error(`Invalid package name: ${name}`)
  let at = from
  while (true) {
    const candidate = join(at, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    const parent = dirname(at)
    if (parent === at) return undefined
    at = parent
  }
}

/** Copy package-declared files; workspace source, credentials and install metadata are never inferred as runtime inputs. */
function copyPackage(source, destination, workspace, exclude) {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  mkdirSync(destination, { recursive: true })
  const patterns = workspace ? [...(manifest.files ?? []), 'package.json', 'LICENSE*', 'license*', 'NOTICE*', 'README*'] : ['*', '.*']
  if (workspace && !Array.isArray(manifest.files)) throw new Error(`Workspace package ${manifest.name} needs an explicit files list`)
  const roots = new Set()
  for (const pattern of patterns) {
    if (isAbsolute(pattern) || pattern.split(/[\\/]/u).includes('..')) throw new Error(`Unsafe package file pattern: ${manifest.name}`)
    for (const path of globSync(pattern, { cwd: source })) roots.add(path)
  }
  const allowed = path => {
    const rel = relative(source, path)
    if (!rel) return true
    const parts = rel.split(sep)
    if (parts.some(part => ['node_modules', '.git', '.DS_Store'].includes(part) || /^\.env(?:\.|$)/u.test(part))) return false
    return !exclude(`node_modules/${manifest.name}/${rel}`)
  }
  for (const file of roots) if (allowed(join(source, file))) copyRuntimeTree(join(source, file), join(destination, file), { filter: allowed })
  // Resolver metadata must not refer to the original workspace checkout.
  if (manifest.dsh?.configTrees) {
    for (const tree of manifest.dsh.configTrees) {
      if (isAbsolute(tree.mount) || tree.mount.split(/[\\/]/u).includes('..')) throw new Error('Unsafe config mount')
      copyRuntimeTree(resolve(source, tree.path), join(destination, tree.mount), { filter: path => !path.split(sep).some(part => ['node_modules', '.git', '.DS_Store'].includes(part) || /^\.env(?:\.|$)/u.test(part)) })
      tree.path = `./${tree.mount}`
    }
    writeFileSync(join(destination, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return manifest
}

/** Materialize a relocatable graph whose package links point exclusively inside destination. */
export function snapshotRuntimeClosure({ entry, destination, repoRoot, exclude = () => false, webDist,
  target = { platform: process.platform, arch: process.arch }, dependencyOverrides = {}, layout = 'symlink' }) {
  if (existsSync(destination)) throw new Error('Runtime destination already exists; select a fresh build directory')
  repoRoot = realpathSync(repoRoot)
  const nodes = new Map()
  const visit = source => {
    source = realpathSync(source)
    const existing = nodes.get(source)
    if (existing) return existing
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    const id = createHash('sha256').update(relative(repoRoot, source)).digest('hex').slice(0, 16)
    const node = { source, manifest, id, dependencies: new Map() }
    nodes.set(source, node)
    const specs = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }
    for (const name of Object.keys(specs).sort()) {
      const optional = Object.hasOwn(manifest.optionalDependencies ?? {}, name)
        || (Object.hasOwn(manifest.peerDependencies ?? {}, name) && manifest.peerDependenciesMeta?.[name]?.optional === true && !Object.hasOwn(manifest.dependencies ?? {}, name))
      const path = dependencyOverrides[name] ?? resolveInstalledPackage(name, source)
      if (!path) {
        if (optional && !name.includes(`${target.platform}-${target.arch}`)) continue
        throw new Error(`Missing target runtime dependency: ${manifest.name} -> ${name} (${target.platform}/${target.arch})`)
      }
      const candidate = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
      if (candidate.name !== name) throw new Error(`Dependency override name mismatch: ${name}`)
      if (optional && (!matchesPlatform(candidate.os, target.platform) || !matchesPlatform(candidate.cpu, target.arch))) continue
      node.dependencies.set(name, visit(path))
    }
    return node
  }
  const root = visit(entry)
  mkdirSync(destination, { recursive: true })
  destination = realpathSync(destination)
  const plugins = new Map()
  for (const node of nodes.values()) {
    if (node === root || !node.manifest.name.startsWith('@deepseek-ai/')) continue
    const previous = plugins.get(node.manifest.name)
    if (previous && previous.source !== node.source) throw new Error(`Ambiguous dynamic plugin: ${node.manifest.name}`)
    plugins.set(node.manifest.name, node)
  }
  const copyNode = (node, at) => {
    const workspace = (node.source === repoRoot || node.source.startsWith(repoRoot + sep)) && !node.source.includes(`${sep}node_modules${sep}`)
    copyPackage(node.source, at, workspace, path => (webDist && node.manifest.name === '@deepseek-ai/dsh-web-frontend' && path.startsWith('node_modules/@deepseek-ai/dsh-web-frontend/dist')) || exclude(path))
    if (node.manifest.name === '@deepseek-ai/dsh-web-frontend' && webDist) copyRuntimeTree(webDist, join(at, 'dist'))
  }
  if (layout === 'hoisted') return writeHoistedRuntime({ root, nodes, plugins, destination, copyNode })
  if (layout !== 'symlink' || target.platform === 'win32') throw new Error('Windows packages require the symlink-free hoisted layout')
  const location = node => node === root ? destination : join(destination, 'node_modules', '.store', node.id, 'package')
  for (const node of nodes.values()) {
    const target = location(node)
    copyNode(node, target)
    for (const [name, dependency] of node.dependencies) {
      const link = join(target, 'node_modules', name)
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(relative(dirname(link), location(dependency)), link, 'dir')
    }
  }
  // Cordis loads profile-named plugins dynamically from its own package. Their
  // unique first-party modules must also be visible at the runtime root.
  for (const [name, node] of plugins) {
    const link = join(destination, 'node_modules', name)
    if (existsSync(link)) continue
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(relative(dirname(link), location(node)), link, 'dir')
  }
  return [...nodes.values()].map(node => ({ name: node.manifest.name, version: node.manifest.version, id: node.id, dependencies: [...node.dependencies.keys()] })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** Electron Builder's maintained Yarn hoister preserves version/peer resolution without Windows symlinks. */
function writeHoistedRuntime({ root, nodes, plugins, destination, copyNode }) {
  const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
  const builderRequire = createRequire(desktopRequire.resolve('electron-builder'))
  const builderEntry = builderRequire.resolve('app-builder-lib')
  const { hoist } = builderRequire(join(dirname(builderEntry), 'node-module-collector', 'hoist.js'))
  const trees = new Map()
  // Peers have already been resolved to concrete installed identities. Model
  // them as required edges and verify every edge after writing the tree; asking
  // the hoister to resolve optional parent peer declarations again loses them.
  for (const node of nodes.values()) trees.set(node, { name: node.manifest.name, identName: node.manifest.name, reference: node.id, dependencies: new Set(), peerNames: new Set() })
  for (const node of nodes.values()) for (const dependency of node.dependencies.values()) trees.get(node).dependencies.add(trees.get(dependency))
  // Profile plugins are intentional direct runtime dependencies even when they
  // were reached through a bundle in the source graph.
  for (const node of plugins.values()) trees.get(root).dependencies.add(trees.get(node))
  const hoisted = hoist(trees.get(root), { check: true })
  const byId = new Map([...nodes.values()].map(node => [node.id, node]))
  const placed = new Map()
  const render = (tree, at, isRoot = false) => {
    if (tree.references.size !== 1) throw new Error(`Ambiguous hoisted package references: ${tree.name}`)
    const node = byId.get([...tree.references][0])
    if (!node) throw new Error(`Unknown hoisted package: ${tree.name}`)
    const location = isRoot ? at : join(at, 'node_modules', tree.name)
    if (placed.has(location)) throw new Error(`Duplicate package destination: ${tree.name}`)
    copyNode(node, location)
    placed.set(location, node)
    for (const dependency of tree.dependencies) render(dependency, location)
  }
  render(hoisted, destination, true)
  // Test Node's real lookup against every selected identity; a flat tree alone
  // does not establish that nested conflicting versions were preserved.
  for (const [at, node] of placed) for (const [name, dependency] of node.dependencies) {
    const resolved = resolveInstalledPackage(name, at)
    const expected = resolved && placed.get(resolved)
    if (expected?.id !== dependency.id) throw new Error(`Packaged dependency resolution changed: ${node.manifest.name} -> ${name}`)
  }
  return [...nodes.values()].map(node => ({ name: node.manifest.name, version: node.manifest.version, id: node.id, dependencies: [...node.dependencies.keys()], locations: [...placed].filter(([, selected]) => selected === node).map(([path]) => relative(destination, path) || '.') })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}
