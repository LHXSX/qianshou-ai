import { useEffect, useSyncExternalStore } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import css from './ProductRail.module.css'

/** Optional live catalog for the product rail's model list. */
export interface ProductRailInjected {
  /** Shared session directory, or null when model selection is not mounted. */
  directory: SnapshotStore<ModelDirectoryState> | null
  /** Load the session catalog; errors land on the store. */
  load: () => void
  /** Open the conversation main panel. */
  openChat: () => void
  /** Open the Models and API destination. */
  openModels: () => void
  /** Open the Task center destination. */
  openTasks: () => void
  /** Apply a catalog row to the current Session. */
  selectModel: (provider: string, model: string) => void
}

/** Guide-chain occupant that replaces the shipped compass with Qianshou chrome. */
export type ProductRailProps =
  & PropsRuntime<'sidebar.right.tab.guide'>
  & PropsLocale<'forge.brand'>
  & InjectFace<ProductRailInjected>

const EMPTY_DIRECTORY: ModelDirectoryState = {
  current: null, lastUsed: null, autoDecision: null, routable: null,
  groups: [], failures: [], status: 'idle', error: null,
}

const TOOLS = [
  { id: 'file', label: 'rail.toolFile', mark: 'file' },
  { id: 'image', label: 'rail.toolImage', mark: 'image' },
  { id: 'search', label: 'rail.toolSearch', mark: 'search' },
  { id: 'think', label: 'rail.toolThink', mark: 'think' },
  { id: 'more', label: 'rail.toolMore', mark: 'more' },
] as const

/** Colored glyph for one quick-tool tile. */
function ToolMark({ mark }: { mark: (typeof TOOLS)[number]['mark'] }) {
  return (
    <span className={css.toolMark} data-tool={mark} aria-hidden="true">
      {mark === 'file' ? (
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M11 4v7H4v2h7v7h2v-7h7v-2h-7V4h-2Z" /></svg>
      ) : mark === 'image' ? (
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M5 5h14v14H5V5Zm2 10 2.5-3 2 2.4L14 12l3 5H7Z" /></svg>
      ) : mark === 'search' ? (
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10 4a6 6 0 1 1 3.8 10.8l3.7 3.7-1.4 1.4-3.7-3.7A6 6 0 0 1 10 4Zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" /></svg>
      ) : mark === 'think' ? (
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 3a7 7 0 0 1 4 12.7V18h-8v-2.3A7 7 0 0 1 12 3Zm-3 17h6v2H9v-2Z" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 11h3v3H6v-3Zm5 0h3v3h-3v-3Zm5 0h3v3h-3v-3Z" /></svg>
      )}
    </span>
  )
}

/** Qianshou right-rail home: live catalog models, composer tools, task empty state. */
export function ProductRail({
  t, directory, load, openChat, openModels, openTasks, selectModel,
}: ProductRailProps) {
  const state = useSyncExternalStore(
    listener => directory === null ? () => {} : directory.subscribe(listener),
    () => directory === null ? EMPTY_DIRECTORY : directory.getSnapshot(),
  )
  useEffect(() => { load() }, [load])
  const models = state.groups.flatMap(group => group.models.map(model => ({
    id: `${group.id}/${model.id}`,
    provider: group.id,
    model: model.id,
    name: model.name,
    detail: model.description ?? group.name,
    current: state.current?.provider === group.id && state.current.model === model.id,
  })))

  return (
    <div className={css.rail} data-qianshou-product-rail="">
      <section className={css.section} aria-labelledby="qianshou-rail-models">
        <div className={css.sectionHead}>
          <h2 id="qianshou-rail-models">{t('rail.models')}</h2>
          <button type="button" className={css.more} onClick={openModels}>{t('rail.modelsMore')}</button>
        </div>
        {models.length === 0 ? (
          <p className={css.empty}>{t('rail.modelsEmpty')}</p>
        ) : (
          <ul className={css.models}>
            {models.map(entry => (
              <li key={entry.id} className={entry.current ? css.current : undefined}>
                <button
                  type="button"
                  className={css.modelButton}
                  aria-current={entry.current ? 'true' : undefined}
                  onClick={() => { selectModel(entry.provider, entry.model) }}
                >
                  <span className={css.modelMark} aria-hidden="true">{entry.name.slice(0, 1)}</span>
                  <span className={css.modelCopy}>
                    <span className={css.modelName}>{entry.name}</span>
                    <span className={css.modelDetail}>{entry.detail}</span>
                  </span>
                  <svg className={css.modelChevron} viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
                    <path fill="currentColor" d="M5.2 2.6 9.6 7 5.2 11.4 4.1 10.3 7.4 7 4.1 3.7z" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className={css.hint}>{t('rail.modelsHint')}</p>
      </section>

      <section className={css.section} aria-labelledby="qianshou-rail-tools">
        <h2 id="qianshou-rail-tools">{t('rail.tools')}</h2>
        <ul className={css.tools}>
          {TOOLS.map(tool => (
            <li key={tool.id}>
              <button type="button" className={css.toolButton} onClick={openChat}>
                <ToolMark mark={tool.mark} />
                <span>{t(tool.label)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className={css.section} aria-labelledby="qianshou-rail-tasks">
        <div className={css.sectionHead}>
          <h2 id="qianshou-rail-tasks">{t('rail.tasks')}</h2>
          <button type="button" className={css.more} onClick={openTasks}>{t('rail.tasksAll')}</button>
        </div>
        <p className={css.empty}>{t('rail.tasksEmpty')}</p>
      </section>
    </div>
  )
}
