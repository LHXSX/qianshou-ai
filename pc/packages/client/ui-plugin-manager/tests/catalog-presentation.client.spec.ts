import { describe, expect, it } from 'vitest'
import type { PackageRow, PackageView } from '../src/client/manager-store.ts'
import { componentSummary, listedPackages, matchesPackage, packageSourceText, packageStatus } from '../src/client/catalog-presentation.ts'
import { en } from '../src/client/locales.ts'
import type { Translate } from '../src/client/presentation.ts'

const t: Translate = ((key: keyof typeof en, values?: Record<string, string>) =>
  Object.entries(values ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), en[key])) as Translate
const row = (phase: PackageRow['phase'], enabled = true): PackageRow => ({ rowId: 'r', moduleName: '@test/module', phase, enabled })
const pkg = (rows: PackageView['rows'], overrides: Partial<PackageView> = {}): PackageView => ({
  name: '@test/dsh-photos', installed: true, optional: false, enabled: true, rows, ...overrides,
})

describe('local plugin loading projection', () => {
  it.each([
    { rows: [], state: 'idle' },
    { rows: [row(null)], state: 'idle' },
    { rows: [row('active')], state: 'active' },
    { rows: [row('active'), row(null, false)], state: 'partial' },
    { rows: [row('active'), row('pending')], state: 'pending' },
    { rows: [row('loading')], state: 'loading' },
    { rows: [row('unloading')], state: 'loading' },
    { rows: [row('active'), row('failed')], state: 'problem' },
    { rows: [row(null, false)], state: 'idle' },
  ])('observes $state from components rather than enablement', ({ rows, state }) => {
    expect(packageStatus(pkg(rows))).toBe(state)
  })

  it('retains a stopping phase until the Host has actually unloaded the components', () => {
    expect(packageStatus(pkg([row('active')], { enabled: false }))).toBe('stopping')
    expect(packageStatus(pkg([row('unloading')], { enabled: false }))).toBe('stopping')
    expect(packageStatus(pkg([row(null, false)], { enabled: false }))).toBe('disabled')
    expect(packageStatus(pkg([], { enabled: false, error: { code: 'not-bundle' } }))).toBe('problem')
  })

  it('separates installed, application-provided and merely selected identities without a verified-publisher claim', () => {
    expect(packageSourceText(pkg([]), t)).toBe(en.catalogSourceInstalled)
    expect(packageSourceText(pkg([], { installed: false, optional: true }), t)).toBe(en.catalogSourceBundled)
    expect(packageSourceText(pkg([], { installed: false }), t)).toBe(en.catalogSourceSelected)
    expect(listedPackages([
      pkg([], { name: '@deepseek-ai/dsh-base' }),
      pkg([], { name: '@custom/dsh-base' }),
      pkg([], { name: 'unselected-dependency', installed: false }),
      pkg([], { name: 'unreadable-selected', installed: false, error: { code: 'not-bundle' } }),
    ]).map(item => item.name)).toEqual(['@custom/dsh-base', 'unreadable-selected'])
  })

  it('accounts for every observed component including waiting and unloading', () => {
    expect(componentSummary([], t)).toBe(en.catalogNoComponents)
    expect(componentSummary([row('active', false)], t)).toBe('1 total · 1 loaded')
    expect(componentSummary([row('active'), row(null, false), row('failed'), row('pending'), row('loading'), row('unloading', false), row(null)], t))
      .toBe('7 total · 1 loaded · 1 off · 1 failed · 1 waiting · 1 loading · 1 unloading · 1 not loaded')
  })

  it('filters actual state and searches package identity, translated name and description locally', () => {
    expect(matchesPackage(pkg([row('failed')]), 'PHOTOS', 'problem', t)).toBe(true)
    expect(matchesPackage(pkg([row('pending')]), '', 'waiting', t)).toBe(true)
    expect(matchesPackage(pkg([row('active')]), '', 'waiting', t)).toBe(false)
    expect(matchesPackage(pkg([], { enabled: false }), '', 'enabled', t)).toBe(false)
    expect(matchesPackage(pkg([], { enabled: false }), '', 'disabled', t)).toBe(true)
    expect(matchesPackage(pkg([], { description: 'Draw landscapes' }), ' landSCAPES ', 'all', t)).toBe(true)
    expect(matchesPackage(pkg([], { name: '@deepseek-ai/dsh-experimental-agent-team-profile' }), 'Agent Teams', 'all', t)).toBe(true)
    expect(matchesPackage(pkg([]), 'missing', 'all', t)).toBe(false)
  })
})
