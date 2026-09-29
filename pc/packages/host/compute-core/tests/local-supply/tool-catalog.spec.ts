/**
 * The trusted tool catalogue and the two readers that must agree on it.
 *
 * The regression these cases pin down was measured, not hypothesised: the host supply page probed
 * `node, git, ffmpeg` while the node's Edge `hello` advertised `node, git, python3`, so this Mac
 * (Apple M4, ffmpeg and ffprobe installed) registered on the dispatcher with no `ffmpeg` in
 * `software` — and every task type requiring ffmpeg became unmatchable on it. A comment claimed the
 * two lists were identical, which is why nobody looked. The fix is one catalogue with two readers;
 * these cases fail if a second list ever grows back.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SupplyHostConfig } from '../../src/supply-host.ts'
import { HOST_SUPPLY_TOOLS, HOST_SUPPLY_TOOL_SPECS, resolveSupplyCommand, supplyToolSearchDirectories } from '../../src/supply/tool-catalog.ts'
import { probeLocalSupply } from '../../src/supply/local-probe.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qianshou-tool-catalog-'))
  roots.push(root)
  return root
}

/** Write a runnable file without relying on the platform's exec-bit semantics beyond POSIX. */
function writeExecutable(path: string): void {
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  if (process.platform !== 'win32') chmodSync(path, 0o755)
}

describe('trusted local tool catalogue', () => {
  it('measures ffmpeg and ffprobe beside node, git and python3', () => {
    // ffmpeg is the one that was missing from the advertisement; ffprobe is what stream-inspection
    // tasks (`video_info`) require. Both are catalogue rows, not deployment extras.
    expect(HOST_SUPPLY_TOOLS.map(tool => tool.id)).toEqual(['node', 'git', 'python3', 'ffmpeg', 'ffprobe'])
    expect(HOST_SUPPLY_TOOL_SPECS.map(spec => spec.id)).toEqual(HOST_SUPPLY_TOOLS.map(tool => tool.id))
    expect(HOST_SUPPLY_TOOL_SPECS.map(spec => [...spec.args])).toEqual(HOST_SUPPLY_TOOLS.map(tool => [...tool.args]))
    for (const tool of HOST_SUPPLY_TOOLS) {
      expect(tool.name.length).toBeGreaterThan(0)
      expect(tool.args.length).toBeGreaterThan(0)
      expect(tool.command.length).toBeGreaterThan(0)
    }
  })

  it('gives the host supply page and the node hello the same default list', () => {
    // `SupplyHostConfig({})` is the real default-application path `createHostSupply` takes; the
    // host-side default is the shared constant, so the supply page and the node advertisement cannot
    // describe two different machines again. The `?? []` is only for the optional field's type: an
    // unfilled default compares unequal to the catalogue and fails right here.
    const hostDefault = SupplyHostConfig({}).tools ?? []
    expect(hostDefault).toEqual([...HOST_SUPPLY_TOOLS])
    expect(hostDefault.map(tool => tool.id)).toContain('ffmpeg')
    // An owner-supplied list still wins: the fix removes a divergence, not a deployment's override.
    const overridden = SupplyHostConfig({ tools: [{ id: 'ffmpeg', name: 'FFmpeg', command: '/custom/ffmpeg', args: ['-version'] }] })
    expect((overridden.tools ?? []).map(tool => tool.id)).toEqual(['ffmpeg'])
  })

  it('addresses a located tool by absolute path and leaves an unlocated one to PATH', () => {
    for (const tool of HOST_SUPPLY_TOOLS) {
      if (isAbsolute(tool.command)) {
        // An absolute command is only ever produced from a file that really exists.
        expect(existsSync(tool.command)).toBe(true)
        continue
      }
      // The bare-name fallback keeps the catalogue's own name, and the probe then reports the tool
      // as `unavailable` instead of the advertisement disappearing.
      expect(tool.command).toBe(tool.id)
    }
    // The node runtime is this process; it is absolute by construction and never searched for.
    expect(isAbsolute(HOST_SUPPLY_TOOLS.find(tool => tool.id === 'node')?.command ?? '')).toBe(true)
  })

  it('prefers the known install directories over the process PATH, in a fixed order', () => {
    const root = fixtureRoot()
    const first = join(root, 'first')
    const second = join(root, 'second')
    mkdirSync(first)
    mkdirSync(second)
    writeExecutable(join(second, 'qianshou-fixture-tool'))
    // A directory whose name matches the command is not an executable, so the search continues past it.
    mkdirSync(join(first, 'qianshou-fixture-tool'))
    expect(resolveSupplyCommand('qianshou-fixture-tool', [first, second]))
      .toBe(join(second, 'qianshou-fixture-tool'))

    const earlier = join(root, 'earlier')
    mkdirSync(earlier)
    writeExecutable(join(earlier, 'qianshou-fixture-tool'))
    expect(resolveSupplyCommand('qianshou-fixture-tool', [earlier, second]))
      .toBe(join(earlier, 'qianshou-fixture-tool'))
  })

  it('never throws for a command it cannot locate', () => {
    const root = fixtureRoot()
    // Not found anywhere: the bare name comes back, so `execFile` fails through the probe's existing
    // `LOCAL_PROBE_UNAVAILABLE` path and the tool is reported `unavailable`.
    expect(resolveSupplyCommand('qianshou-absent-tool', [root])).toBe('qianshou-absent-tool')
    // An absolute command is never searched for, and is returned unchanged.
    expect(resolveSupplyCommand('/nonexistent/qianshou-tool', [root])).toBe('/nonexistent/qianshou-tool')
    // A file without any execute bit is not a usable command on POSIX.
    if (process.platform !== 'win32') {
      const plain = join(root, 'qianshou-plain-file')
      writeFileSync(plain, 'not executable\n', { mode: 0o644 })
      expect(resolveSupplyCommand('qianshou-plain-file', [root])).toBe('qianshou-plain-file')
    }
  })

  it('searches the packaged app runtime directory when the host runs from it', () => {
    const resources = join(fixtureRoot(), '千手智能体.app', 'Contents', 'Resources')
    const runtimeBin = join(resources, 'runtime', 'bin')
    // The Host the desktop app spawns is `<resources>/runtime/node/node`.
    const directories = supplyToolSearchDirectories(join(resources, 'runtime', 'node', 'node'))
    expect(directories).toContain(runtimeBin)
    if (process.platform !== 'win32') {
      // A dev checkout sits elsewhere entirely; the bundled-runtime candidate must not be invented.
      expect(supplyToolSearchDirectories(join(fixtureRoot(), 'node'))).toEqual(['/opt/homebrew/bin', '/usr/local/bin'])
    }
  })

  it('reports every catalogue tool from the real probe, unavailable rather than thrown', async () => {
    const result = await probeLocalSupply({
      timeoutMs: 1000, maxResponseBytes: 65536, tools: HOST_SUPPLY_TOOLS,
      readHostActivity: () => ({ foregroundTaskActive: null, voiceActive: null }),
    }, undefined, async command => (command.includes('ffprobe') ? 'ffprobe version 8.0.1' : 'ffmpeg version 8.0.1'))
    // One row per catalogue entry, in catalogue order — a missing binary is a row, not a hole.
    expect(result.localServices.map(service => service.id))
      .toEqual(HOST_SUPPLY_TOOLS.map(tool => tool.id))
    // The version facts the probe keeps, for the two tools whose absence caused the dispatch gap.
    expect(result.localServices.find(service => service.id === 'ffmpeg'))
      .toMatchObject({ kind: 'tool', verification: 'verified', version: '8.0.1' })
    expect(result.localServices.find(service => service.id === 'ffprobe'))
      .toMatchObject({ kind: 'tool', verification: 'verified', version: '8.0.1' })

    const failing = await probeLocalSupply({
      timeoutMs: 1000, maxResponseBytes: 65536, tools: HOST_SUPPLY_TOOLS,
      readHostActivity: () => ({ foregroundTaskActive: null, voiceActive: null }),
    }, undefined, async () => { throw new Error('LOCAL_PROBE_UNAVAILABLE') })
    // A tool that cannot be executed is `unavailable` with a reason: the probe still answers, so the
    // hello keeps the facts it did measure instead of failing as a whole.
    expect(failing.localServices.find(service => service.id === 'ffmpeg'))
      .toMatchObject({ verification: 'unavailable', reason: 'LOCAL_TOOL_CHECK_FAILED', version: null })
  })
})
