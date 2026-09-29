import { describe, expect, it, vi } from 'vitest'
import { ContributorResourceObserver, type ContributorResourceSources } from '../src/resource-observer.ts'

const sources: ContributorResourceSources = {
  readUserActivity: () => false, readVoiceActivity: () => false, readCpuPercent: () => 20,
  readGpuPercent: () => 40, readTemperatureC: () => 60, readDiskFreeBytes: () => 10_000,
}

describe('contributor resource observer', () => {
  it('assembles and validates a snapshot without deciding admission', async () => {
    await expect(new ContributorResourceObserver(sources).sample(2)).resolves.toEqual({
      userActive: false, voiceActive: false, cpuPercent: 20, gpuPercent: 40,
      temperatureC: 60, diskFreeBytes: 10_000, runningTasks: 2,
    })
  })

  it('fails closed when a native source throws or reports an impossible value', async () => {
    const failing = { ...sources, readGpuPercent: vi.fn(() => { throw new Error('driver') }) }
    await expect(new ContributorResourceObserver(failing).sample(0)).rejects.toThrow('COMPUTE_RESOURCE_UNAVAILABLE')
    await expect(new ContributorResourceObserver({ ...sources, readGpuPercent: () => undefined }).sample(0)).rejects.toThrow('COMPUTE_RESOURCE_UNAVAILABLE')
    await expect(new ContributorResourceObserver({ ...sources, readCpuPercent: () => 101 }).sample(0)).rejects.toThrow('COMPUTE_RESOURCE_SNAPSHOT_INVALID')
    await expect(new ContributorResourceObserver(sources).sample(-1)).rejects.toThrow('COMPUTE_RESOURCE_TASK_COUNT_INVALID')
  })
})
