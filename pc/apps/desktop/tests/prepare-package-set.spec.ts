import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertDesktopHostPackageFiles,
  assertPackedPresetPackageClosures,
  assertPackedRelativeImportClosure,
  packedPresetEntry,
  presetPackageSpecifiers,
  selectDesktopPackageClosure,
  type PackedDesktopPackage,
} from '../scripts/prepare-package-set.ts'

function packed(name: string, manifest: Record<string, unknown> = {}): PackedDesktopPackage {
  return { tarball: `${name}.tgz`, manifest: { name, version: '1.0.0', ...manifest } }
}

describe('desktop package-set selection', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not select a packaging target when imported as a library', async () => {
    vi.stubEnv('DSH_DESKTOP_TARGET_PLATFORM', 'linux')
    vi.stubEnv('DSH_DESKTOP_TARGET_ARCH', 'x64')
    vi.resetModules()
    await expect(import('../scripts/prepare-package-set.ts')).resolves.toHaveProperty('prepareDesktopPackageSet')
  })

  it('includes only the available internal production closure', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: { '@deepseek-ai/dsh-base': '^1.0.0', external: '^2.0.0' },
        optionalDependencies: { '@deepseek-ai/platform-package': '1.0.0', '@deepseek-ai/missing-platform': '1.0.0' },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', {
        dependencies: { '@deepseek-ai/dsh': '^1.0.0' },
      })],
      ['@deepseek-ai/dsh-base', packed('@deepseek-ai/dsh-base', {
        peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' },
      })],
      ['@deepseek-ai/cordis', packed('@deepseek-ai/cordis')],
      ['@deepseek-ai/platform-package', packed('@deepseek-ai/platform-package')],
      ['@deepseek-ai/unused', packed('@deepseek-ai/unused')],
    ])
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name)).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-desktop-host',
      '@deepseek-ai/platform-package',
    ])
  })

  it.each([
    '@deepseek-ai/dsh-base', '@deepseek-ai/cordis', '@deepseek-ai/node-addon-system',
  ])('rejects required prepared package %s absent from the packed release inputs', (dependency) => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: { [dependency]: '^1.0.0' },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', {
        dependencies: { '@deepseek-ai/dsh': '^1.0.0' },
      })],
    ])
    expect(() => selectDesktopPackageClosure(available)).toThrow(/unpacked package/u)
    expect(() => selectDesktopPackageClosure(new Map([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
    ]))).toThrow(/omit @deepseek-ai\/dsh-desktop-host/u)
  })

  it('leaves independently published Office packages to npm resolution', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: {
          '@deepseek-ai/libreoffice-kit': '0.0.1',
          '@deepseek-ai/libreoffice-kit-wasm': '0.0.1',
        },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
    ])
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name)).toEqual([
      '@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host',
    ])
  })

  it('requires the Desktop Host entry', () => {
    const files = [
      'package/lib/index.js',
    ]
    expect(() => {
      assertDesktopHostPackageFiles(files)
    }).not.toThrow()
    expect(() => {
      assertDesktopHostPackageFiles(files.slice(1))
    }).toThrow(/lib\/index\.js/u)
  })

  it('rejects packed memory entries whose generated shared module is missing', () => {
    const entries = ['package/lib/index.js', 'package/lib/tools.js']
    const contents: Record<string, string> = {
      'package/lib/index.js': 'import { value } from "./validation-abc123.js"; export { value }',
      'package/lib/tools.js': 'import { value } from "./validation-abc123.js"; export { value }',
      'package/lib/validation-abc123.js': 'export const value = 1',
    }
    expect(() => { assertPackedRelativeImportClosure(entries, entries, file => contents[file] as string) })
      .toThrow(/imports missing packed module.*validation-abc123\.js/u)
    expect(() => { assertPackedRelativeImportClosure([...entries, 'package/lib/validation-abc123.js'], entries,
      file => contents[file] as string) }).not.toThrow()
  })

  it('collects exact mounted package subpaths from every shipped preset', () => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-preset-closure-'))
    try {
      mkdirSync(join(root, 'ceo'))
      mkdirSync(join(root, 'creator'))
      writeFileSync(join(root, 'ceo', 'agent.cordis.yml'),
        `- name: '@deepseek-ai/dsh-host-qianshou-memory/tools'\n- name: '@deepseek-ai/dsh-compute-core/private-mac-video-tool'\n`)
      writeFileSync(join(root, 'creator', 'agent.cordis.yml'),
        `- name: '@deepseek-ai/dsh-compute-core/private-mac-video-tool'\n`)
      expect(presetPackageSpecifiers(root)).toEqual([
        '@deepseek-ai/dsh-compute-core/private-mac-video-tool',
        '@deepseek-ai/dsh-host-qianshou-memory/tools',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an old packed preset subpath and a missing dynamic ESM chunk before packaging', () => {
    const specifier = '@deepseek-ai/dsh-compute-core/private-mac-video-tool'
    const old = packed('@deepseek-ai/dsh-compute-core', {
      exports: { '.': { default: './lib/index.js' } },
    })
    expect(() => packedPresetEntry(specifier, old.manifest)).toThrow(/no exact packed runtime export/u)

    const current = packed('@deepseek-ai/dsh-compute-core', {
      exports: { '.': { default: './lib/index.js' },
        './private-mac-video-tool': { types: './lib/types/private-mac-video-tool.d.ts',
          default: './lib/private-mac-video-tool.js' } },
    })
    const source: Record<string, string> = {
      'package/lib/private-mac-video-tool.js': 'export async function trial() { return import("./validation-Ce8WwIVI.js") }',
      'package/lib/validation-Ce8WwIVI.js': 'export const accepted = true',
    }
    const check = (files: string[]): void => assertPackedPresetPackageClosures([specifier], [current],
      () => files, (_, file) => source[file] as string)
    expect(() => check([])).toThrow(/omits package\/lib\/private-mac-video-tool\.js/u)
    expect(() => check(['package/lib/private-mac-video-tool.js']))
      .toThrow(/imports missing packed module.*validation-Ce8WwIVI\.js/u)
    expect(() => check(Object.keys(source))).not.toThrow()
    expect(() => assertPackedPresetPackageClosures([specifier], [], () => [], () => ''))
      .toThrow(/preset requires unpacked package/u)
  })
})
