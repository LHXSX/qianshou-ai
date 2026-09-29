/** Git merge-driver and explicit conflict-resolver entrypoint for pairing records. */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  mergeTranslationPairingRecords,
  repositoryTranslationPairSource,
  resolveTranslationPairingConflicts,
} from './translation-pairing-merge.ts'

const args = process.argv.slice(2)

try {
  if (args[0] === '--probe') {
    if (args.length !== 1) throw new Error('--probe takes no other arguments')
  } else {
    const root = resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim())
    const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const relativeProject = relative(root, project)
    if (isAbsolute(relativeProject) || relativeProject === '..' || relativeProject.startsWith(`..${sep}`)
      || resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: project, encoding: 'utf8' }).trim()) !== root) {
      throw new Error('pairing project must belong to the current worktree')
    }
    const projectPrefix = relativeProject.split(sep).join('/')
    if (args[0] === '--project-prefix') {
      args.shift()
      const explicitPrefix = args.shift()
      if (projectPrefix === '' || explicitPrefix !== projectPrefix) {
        throw new Error('pairing project prefix must name this package in the current worktree')
      }
    }
    const source = repositoryTranslationPairSource(root, projectPrefix)
    if (args[0] === '--resolve') {
      if (args.length !== 1) throw new Error('--resolve takes no paths; it inspects the unmerged index')
      const resolved = resolveTranslationPairingConflicts(root, source)
      if (resolved.length === 0) {
        console.log('merge-translation-pairing: no unresolved pairing records')
      } else {
        for (const path of resolved) console.log(`merge-translation-pairing: resolved ${path}`)
      }
    } else {
      if (args.length !== 4) {
        throw new Error('merge-driver mode requires <ancestor> <current> <other> <repository-path>')
      }
      const [ancestorPath, currentPath, otherPath, metaPath] = args
      if (ancestorPath === undefined || currentPath === undefined || otherPath === undefined || metaPath === undefined) {
        throw new Error('merge-driver arguments are incomplete')
      }
      const result = mergeTranslationPairingRecords(
        root,
        metaPath,
        readFileSync(ancestorPath, 'utf8'),
        readFileSync(currentPath, 'utf8'),
        readFileSync(otherPath, 'utf8'),
        source,
      )
      writeFileSync(currentPath, result.record)
    }
  }
} catch (error) {
  console.error(`merge-translation-pairing: ${error instanceof Error ? error.message : String(error)}`)
  console.error(
    'merge-translation-pairing: resolve owner conflicts, then confirm the pair with '
    + '`pnpm run verify-translation-pairing --write <pair>`; rerun '
    + '`pnpm run resolve-translation-pairing-conflicts` for other safe records',
  )
  process.exitCode = 1
}
