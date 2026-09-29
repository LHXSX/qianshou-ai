import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelDirectoryState } from './directory.ts'

/** Enable task routing within the currently selected provider's loaded catalog. */
export function automaticSelection(state: ModelDirectoryState): ModelSelection | undefined {
  const current = state.current
  if (current === null) return undefined
  const group = state.groups.find(item => item.id === current.provider)
  if (group === undefined || group.models.length === 0 || group.models.length > 64
    || !group.models.some(model => model.id === current.model)) return undefined
  return {
    provider: current.provider,
    model: current.model,
    routing: {
      model: 'auto',
      effort: 'auto',
      candidates: [...new Set(group.models.map(model => model.id))],
    },
  }
}

/** A manual model pick locks the route while retaining independently automatic effort. */
export function manualModelSelection(current: ModelSelection | null, picked: ModelSelection): ModelSelection {
  if (current?.routing?.effort !== 'auto') return picked
  return {
    provider: picked.provider,
    model: picked.model,
    routing: { model: 'manual', effort: 'auto', candidates: [picked.model] },
  }
}

/** Change effort policy without turning an automatic model route into a manual one. */
export function effortSelection(current: ModelSelection, effort: string | undefined, automatic: boolean): ModelSelection {
  const modelAuto = current.routing?.model === 'auto'
  return {
    provider: current.provider,
    model: current.model,
    ...automatic || effort === undefined ? {} : { reasoningEffort: effort },
    ...modelAuto || automatic ? {
      routing: {
        model: modelAuto ? 'auto' : 'manual',
        effort: automatic ? 'auto' : 'manual',
        candidates: modelAuto ? current.routing.candidates : [current.model],
      },
    } : {},
  }
}
