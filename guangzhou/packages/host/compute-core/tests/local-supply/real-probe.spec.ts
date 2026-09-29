import { expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { probeLocalSupply } from '../../src/supply/local-probe.ts'

it('observes this machine without accessing provider settings or invoking a model', async () => {
  const result = await probeLocalSupply({ timeoutMs: 3000, maxResponseBytes: 65536,
    tools: [
      { id: 'node', name: 'Node.js', command: process.execPath, args: ['--version'] },
      { id: 'python3', name: 'Python', command: 'python3', args: ['--version'] },
      { id: 'ffmpeg', name: 'FFmpeg', command: 'ffmpeg', args: ['-version'] },
    ], readHostActivity: () => ({ foregroundTaskActive: null, voiceActive: null }) })
  expect(result.hardware.totalMemoryBytes).toBeGreaterThan(0)
  expect(result.hardware.logicalCores).toBeGreaterThan(0)
  expect(result.activity.foregroundTaskActive).toBeNull()
  const evidenceDirectory = process.env.QIANSHOU_SUPPLY_EVIDENCE_DIR
  if (evidenceDirectory) {
    if (!isAbsolute(evidenceDirectory)) throw new Error('Probe evidence path must be absolute')
    await mkdir(evidenceDirectory, { recursive: true })
    await writeFile(join(evidenceDirectory, 'real-probe.json'), `${JSON.stringify(result, null, 2)}\n`)
  }
}, 10000)
