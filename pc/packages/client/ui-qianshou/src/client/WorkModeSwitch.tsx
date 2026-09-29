/** Small 日常/工作 mode switch used by the Qianshou sidebar shell. */
import { useEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkMode } from './work-mode-controller.ts'
import css from './WorkModeSwitch.module.css'

interface WorkModeInjected {
  readonly hooks: { readonly mode: SnapshotStore<WorkMode> }
  readonly selectMode: (mode: WorkMode, activePanel: MainPanelId | null) => void
  readonly observePanel: (activePanel: MainPanelId | null) => void
}

/** Daily opens the ordinary conversation; Work restores its last panel. */
export function WorkModeSwitch({ wide, t, useMode, usePanelInfo, selectMode, observePanel }:
  PropsRuntime<'sidebar.mode'> & PropsLocale<'qianshou.brand'> & InjectFace<WorkModeInjected>) {
  const mode = useMode(value => value)
  const activePanel = usePanelInfo(value => value.activePanelId)
  useEffect(() => { observePanel(activePanel) }, [activePanel, observePanel])
  if (!wide) return null
  return (
    <div className={css.root} role="group" aria-label={t('workModeLabel')} data-qianshou-work-mode={mode}>
      {(['daily', 'work'] as const).map(item => (
        <button
          key={item}
          type="button"
          className={item === mode ? css.selected : css.option}
          aria-pressed={item === mode}
          onClick={() => { selectMode(item, activePanel) }}
        >
          {t(item === 'daily' ? 'workModeDaily' : 'workModeWork')}
        </button>
      ))}
    </div>
  )
}
