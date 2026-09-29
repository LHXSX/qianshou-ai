/** Parent publication repairs catalog reads taken before ordinary history activation. */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentCatalog } from '@deepseek-ai/dsh-subagent/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { SessionManager } from '../src/client/sessions/manager.ts'
import type { SessionRemotes } from '../src/client/sessions/remotes.ts'

const parent = 'availability-parent' as SessionId
const child = 'availability-child' as SessionId
const children: SubagentCatalog['entries'] = [{
  kind: 'child', id: child, mode: 'continuable', label: 'existing child', activity: 'inactive', hasChildren: false,
}]
const summary = { sessionId: parent, updatedAt: 100, running: false, blank: false }
const result = (available: boolean): RemoteResult<SubagentCatalog> => ({
  ok: true, value: { entries: children, parentAvailable: available },
})

describe('SessionManager parent catalog availability', () => {
  it.each([false, true])('refreshes publication after an earlier catalog is still pending: %s', async (pending) => {
    vi.useFakeTimers()
    const cold = Promise.withResolvers<RemoteResult<SubagentCatalog>>()
    const list = vi.fn<SessionRemotes['subagents']['list']>()
      .mockReturnValueOnce(cold.promise).mockResolvedValue(result(true))
    // This observer never opens history or sends a prompt; only catalog reads run.
    const manager = new SessionManager({ subagents: { list } } as unknown as SessionRemotes)
    try {
      manager.setSubagentCatalogOpen(parent, true)
      const initial = manager.refreshSubagents(parent)
      if (!pending) {
        cold.resolve(result(false))
        await initial
        expect(manager.getListSnapshot().subagentsByParent[parent]?.parentAvailable).toBe(false)
      }

      manager.handleSessionAdded(summary)
      await vi.advanceTimersByTimeAsync(50)
      if (pending) {
        cold.resolve(result(false))
        await initial
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(list).toHaveBeenCalledTimes(2)
      expect(manager.getListSnapshot().subagentsByParent[parent]).toMatchObject({
        state: 'ready', parentAvailable: true, entries: children,
      })

      manager.setSubagentCatalogOpen(parent, false)
      manager.handleSessionAdded(summary)
      await vi.advanceTimersByTimeAsync(1000)
      expect(list).toHaveBeenCalledTimes(2)
    } finally {
      await manager.dispose()
      vi.useRealTimers()
    }
  })
})
