import type { ForgeBrandKey } from './locales.ts'

/** One product-nav destination that has no independent backend yet. */
export interface ProductDestination {
  /** Main-panel and sidebar-panellist id. */
  readonly id: 'qianshou-agents' | 'qianshou-workflows' | 'qianshou-files' | 'qianshou-models-api'
  /** Sidebar row order among other global panels. */
  readonly order: number
  /** Title key in the forge.brand dictionary. */
  readonly title: ForgeBrandKey
  /** Empty-state body key in the forge.brand dictionary. */
  readonly body: ForgeBrandKey
}

/** Product destinations that keep mockup labels without inventing catalogs. */
export const PRODUCT_DESTINATIONS = [
  { id: 'qianshou-agents', order: 2, title: 'dest.agents.title', body: 'dest.agents.body' },
  { id: 'qianshou-workflows', order: 4, title: 'dest.workflows.title', body: 'dest.workflows.body' },
  { id: 'qianshou-files', order: 7, title: 'dest.files.title', body: 'dest.files.body' },
  { id: 'qianshou-models-api', order: 8, title: 'dest.models.title', body: 'dest.models.body' },
] as const satisfies readonly ProductDestination[]
