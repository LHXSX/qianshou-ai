import { expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { probeLocalSupply } from '../../src/supply/local-probe.ts'
import { HOST_SUPPLY_TOOLS } from '../../src/supply/tool-catalog.ts'

it('observes this machine without accessing provider settings or invoking a model', async () => {
  const result = await probeLocalSupply({ timeoutMs: 3000, maxResponseBytes: 65536,
    // The production catalogue, not a hand-written list: this case must observe exactly the tools the
    // node advertises, ffmpeg and ffprobe included, on whatever machine runs it.
    tools: HOST_SUPPLY_TOOLS,
    readHostActivity: () => ({ foregroundTaskActive: null, voiceActive: null }) })
  expect(result.hardware.totalMemoryBytes).toBeGreaterThan(0)
  expect(result.hardware.logicalCores).toBeGreaterThan(0)
  expect(result.activity.foregroundTaskActive).toBeNull()
  // Every catalogue tool is reported, verified or unavailable; a missing binary is a row, not a hole.
  expect(result.localServices.map(service => service.id)).toEqual(HOST_SUPPLY_TOOLS.map(tool => tool.id))
  const evidenceDirectory = process.env.QIANSHOU_SUPPLY_EVIDENCE_DIR
  if (evidenceDirectory) {
    if (!isAbsolute(evidenceDirectory)) throw new Error('Probe evidence path must be absolute')
    await mkdir(evidenceDirectory, { recursive: true })
    await writeFile(join(evidenceDirectory, 'real-probe.json'), `${JSON.stringify(result, null, 2)}\n`)
  }
}, 10000)
