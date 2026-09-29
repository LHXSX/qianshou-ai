import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopUpdateState } from '../src/ipc.ts'
import { DesktopUpdateAutoInstall } from '../src/update-auto-install.ts'

afterEach(() => { vi.useRealTimers() })

function fixture() {
  vi.useFakeTimers()
  let enabled = true
  let state: DesktopUpdateState = { phase: 'ready', version: '1.0.1' }
  const install = vi.fn(async (_version: string): Promise<DesktopUpdateState> => state)
  const automatic = new DesktopUpdateAutoInstall(() => state, install, () => enabled, 30_000, 60_000)
  return { automatic, install, setEnabled: (next: boolean) => { enabled = next; automatic.refresh() },
    setState: (next: DesktopUpdateState) => { state = next; automatic.refresh() } }
}

describe('automatic installation of a verified package', () => {
  it('retries busy and unknown work without repeating a download or interrupting the Host', async () => {
    const f = fixture()
    try {
      f.automatic.refresh()
      await vi.advanceTimersByTimeAsync(29_999)
      expect(f.install).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(f.install).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(f.install).toHaveBeenCalledTimes(2)
      f.install.mockResolvedValueOnce({ phase: 'installing', version: '1.0.1' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(f.install).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(f.install).toHaveBeenCalledTimes(3)
    } finally { f.automatic.dispose() }
  })

  it('cancels a queued restart when the owner disables automatic updates', async () => {
    const f = fixture()
    try {
      f.automatic.refresh()
      f.setEnabled(false)
      await vi.advanceTimersByTimeAsync(90_000)
      expect(f.install).not.toHaveBeenCalled()
      f.setEnabled(true)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(f.install).toHaveBeenCalledOnce()
    } finally { f.automatic.dispose() }
  })

  it('respects Later for the current version and resumes only after an explicit re-enable or new launch', async () => {
    const f = fixture()
    try {
      f.automatic.refresh()
      f.automatic.defer('1.0.1')
      await vi.advanceTimersByTimeAsync(120_000)
      expect(f.install).not.toHaveBeenCalled()
      f.automatic.refresh()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(f.install).not.toHaveBeenCalled()
      f.automatic.enableAgain()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(f.install).toHaveBeenCalledOnce()
    } finally { f.automatic.dispose() }
  })

  it('never installs an unprepared or replaced version', async () => {
    const f = fixture()
    try {
      f.automatic.refresh()
      f.setState({ phase: 'downloading', version: '1.0.2', percent: 50 })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(f.install).not.toHaveBeenCalled()
      f.setState({ phase: 'ready', version: '1.0.2' })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(f.install).toHaveBeenCalledExactlyOnceWith('1.0.2')
    } finally { f.automatic.dispose() }
  })
})
