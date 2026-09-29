import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

export type WorkMode = 'daily' | 'work'

interface PanelNavigation { selectPanel(id: MainPanelId | null): void }

/** Keep mode and the work page in the product plugin, across sidebar collapse. */
export class WorkModeController {
  readonly store = createSnapshotStore<WorkMode>('work')
  private lastWorkPanel: MainPanelId | null = null

  constructor(private readonly layout: PanelNavigation) {}

  select(mode: WorkMode, activePanel: MainPanelId | null): void {
    if (mode === this.store.getSnapshot()) return
    if (mode === 'daily') {
      this.lastWorkPanel = activePanel
      this.layout.selectPanel(null)
      this.store.set('daily')
      return
    }
    this.store.set('work')
    if (this.lastWorkPanel === null) return
    try { this.layout.selectPanel(this.lastWorkPanel) }
    catch { this.layout.selectPanel(null) }
  }

  /** Opening a work panel through another entry also returns to work mode. */
  observePanel(activePanel: MainPanelId | null): void {
    if (activePanel === null) return
    this.lastWorkPanel = activePanel
    if (this.store.getSnapshot() === 'daily') this.store.set('work')
  }
}
