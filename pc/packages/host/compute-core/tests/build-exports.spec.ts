import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import buildConfig from '../tsdown.config.ts'

it('emits every declared Host JavaScript export from its corresponding compiled source', () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    exports: Record<string, string | { default: string }>
  }
  const config = buildConfig
  const entries = new Set(config.entry as string[])
  const runtimeTargets = Object.values(manifest.exports)
    .map(value => typeof value === 'string' ? value : value.default)
    .filter(target => target.startsWith('./lib/') && target.endsWith('.js'))

  expect(runtimeTargets.length).toBeGreaterThan(30)
  for (const target of runtimeTargets) {
    const compiledSource = target.replace('./lib/', 'lib/types/')
    expect(entries, `Declared runtime export ${target} must have a build entry`).toContain(compiledSource)
  }
  expect(config.outDir).toBe('lib')
})

it('declares the native lease and V2 evidence modules consumed by the built H3 chain', () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    exports: Record<string, { types: string; default: string }>
  }
  for (const name of ['native-h3-task-lease', 'native-h3-v2-evidence']) {
    expect(manifest.exports[`./${name}`]).toEqual({
      types: `./lib/types/${name}.d.ts`, default: `./lib/${name}.js`,
    })
    expect(buildConfig.entry).toContain(`lib/types/${name}.js`)
  }
})
