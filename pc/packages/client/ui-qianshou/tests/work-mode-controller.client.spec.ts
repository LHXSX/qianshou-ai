import { describe, expect, it, vi } from 'vitest'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { WorkModeController } from '../src/client/work-mode-controller.ts'

const market = 'plugins' as MainPanelId
const orders = 'qianshou-intake' as MainPanelId

describe('Qianshou work mode navigation', () => {
  it('opens conversation for daily and restores the previous work page', () => {
    const selectPanel = vi.fn()
    const mode = new WorkModeController({ selectPanel })
    mode.select('daily', market)
    expect(mode.store.getSnapshot()).toBe('daily')
    expect(selectPanel).toHaveBeenLastCalledWith(null)
    mode.select('work', null)
    expect(mode.store.getSnapshot()).toBe('work')
    expect(selectPanel).toHaveBeenLastCalledWith(market)
  })

  it('returns to work when another entry opens a work panel', () => {
    const selectPanel = vi.fn()
    const mode = new WorkModeController({ selectPanel })
    mode.select('daily', null)
    mode.observePanel(orders)
    expect(mode.store.getSnapshot()).toBe('work')
    mode.select('daily', orders)
    mode.select('work', null)
    expect(selectPanel).toHaveBeenLastCalledWith(orders)
  })
})
