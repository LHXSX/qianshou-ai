/** Staged team roster and exact model routes for future employee dispatches. */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CardShell } from './card-form.ts'

/** Host settings namespace for employee definitions. */
export const EMPLOYEES_NS = 'qianshou-employees'

/** An exact model route; null at the owning field means inheritance. */
export interface EmployeeRoute { provider: string; model: string }
/** A stable employee identity and its user-authored responsibility. */
export interface EmployeeDefinition {
  id: string
  name: string
  role: string
  route: EmployeeRoute | null
}
/** Settings saved atomically for subsequent dispatches. */
export interface EmployeesSettings {
  defaultRoute: EmployeeRoute | null
  employees: EmployeeDefinition[]
}
/** Current directory metadata, including retained unavailable routes. */
export interface EmployeeModelOption extends EmployeeRoute {
  key: string
  providerName: string
  modelName: string
  available: boolean
}
/** Snapshot consumed by the employee settings card. */
export interface EmployeesCardState extends CardShell, EmployeesSettings {
  models: readonly EmployeeModelOption[]
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  catalogPartial: boolean
  conflicted: boolean
}
/** Renderer-bound state and staged actions. */
export interface EmployeesCardFace {
  hooks: { employeesCard: SnapshotStore<EmployeesCardState> }
  addEmployee: () => void
  removeEmployee: (id: string) => void
  editEmployee: (id: string, field: 'name' | 'role', value: string) => void
  setRoute: (id: string | null, key: string) => void
  retryCatalog: () => void
  save: () => void
  discard: () => void
}

/**
 * Identify one route without making display text part of its identity.
 * @param route - A stored provider/model route.
 * @returns A stable lookup key, or the inheritance sentinel.
 */
export function employeeRouteKey(route: EmployeeRoute | null): string {
  return route === null ? '' : JSON.stringify([route.provider, route.model])
}

function clone(value: EmployeesSettings): EmployeesSettings {
  return {
    defaultRoute: value.defaultRoute === null ? null : { ...value.defaultRoute },
    employees: value.employees.map(employee => ({ ...employee, route: employee.route === null ? null : { ...employee.route } })),
  }
}

function same(left: EmployeesSettings, right: EmployeesSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Owns drafts, directory refreshes, and revision-fenced roster saves. */
export class EmployeesCardController {
  private draft: EmployeesSettings | undefined
  private draftRevision: number | undefined
  private groups: readonly ModelProviderGroup[] = []
  private catalogStatus: EmployeesCardState['catalogStatus'] = 'idle'
  private catalogPartial = false
  private conflicted = false
  private saving = false
  private failed = false
  private disposed = false
  private generation = 0
  private catalogGeneration = 0
  private readonly store: SnapshotStore<EmployeesCardState>
  private readonly unsubscribe: () => void

  /**
   * @param scope - Host-owned roster settings scope.
   * @param ctx - Injected context exposing the real model directory.
   * @param newEmployeeName - Current localized name for a newly staged employee.
   */
  constructor(
    private readonly scope: SettingsScope<EmployeesSettings>,
    private readonly ctx: Context,
    private readonly newEmployeeName: () => string,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      if (!this.saving && this.draft !== undefined && this.scope.getSnapshot().revision !== this.draftRevision) {
        if (same(this.current(), this.draft)) this.clearDraft()
        else this.conflicted = true
      }
      if (this.scope.getSnapshot().status === 'ready' && this.catalogStatus === 'idle') void this.loadCatalog()
      this.publish()
    })
    if (scope.getSnapshot().status === 'ready') void this.loadCatalog()
  }

  /** Stop scope observation and invalidate pending asynchronous settlements. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.catalogGeneration += 1
    this.unsubscribe()
  }

  /**
   * Expose renderer bindings without passing a service into React.
   * @returns The card observable and staged actions.
   */
  inject(): EmployeesCardFace {
    return {
      hooks: { employeesCard: this.store },
      addEmployee: () => { this.addEmployee() },
      removeEmployee: (id) => {
        this.edit((draft) => { draft.employees = draft.employees.filter(employee => employee.id !== id) })
      },
      editEmployee: (id, field, value) => {
        this.edit((draft) => {
          const row = draft.employees.find(employee => employee.id === id)
          if (row) row[field] = value
        })
      },
      setRoute: (id, key) => { this.setRoute(id, key) },
      retryCatalog: () => { void this.loadCatalog() },
      save: () => { void this.save() },
      discard: () => { if (!this.saving) { this.clearDraft(); this.publish() } },
    }
  }

  private current(): EmployeesSettings {
    const value = this.scope.getSnapshot().value
    return { defaultRoute: value?.defaultRoute ?? null, employees: value?.employees ?? [] }
  }

  private value(): EmployeesSettings { return this.draft ?? this.current() }

  private edit(change: (draft: EmployeesSettings) => void): void {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || this.saving || snapshot.status !== 'ready' || !snapshot.writable) return
    if (this.draft === undefined) {
      this.draft = clone(this.current())
      this.draftRevision = snapshot.revision
    }
    change(this.draft)
    this.failed = false
    this.publish()
  }

  private addEmployee(): void {
    this.edit((draft) => {
      if (draft.employees.length >= 24) return
      const ids = new Set(draft.employees.map(employee => employee.id))
      let number = 1
      while (ids.has(`employee-${number}`)) number += 1
      draft.employees.push({ id: `employee-${number}`, name: this.newEmployeeName(), role: '', route: null })
    })
  }

  private setRoute(id: string | null, key: string): void {
    const option = this.models().find(model => model.key === key)
    if (key !== '' && (option === undefined || !option.available)) return
    const route = option === undefined ? null : { provider: option.provider, model: option.model }
    this.edit((draft) => {
      if (id === null) draft.defaultRoute = route
      else {
        const employee = draft.employees.find(row => row.id === id)
        if (employee) employee.route = route
      }
    })
  }

  private models(): EmployeeModelOption[] {
    const rows = new Map<string, EmployeeModelOption>()
    for (const group of this.groups) {
      for (const model of group.models) {
        const route = { provider: group.id, model: model.id }
        const key = employeeRouteKey(route)
        rows.set(key, { ...route, key, providerName: group.name, modelName: model.name, available: true })
      }
    }
    const value = this.value()
    for (const route of [value.defaultRoute, ...value.employees.map(employee => employee.route)]) {
      if (route === null) continue
      const key = employeeRouteKey(route)
      if (!rows.has(key)) rows.set(key, { ...route, key, providerName: route.provider, modelName: route.model, available: false })
    }
    return [...rows.values()]
  }

  private clearDraft(): void {
    this.draft = undefined
    this.draftRevision = undefined
    this.conflicted = false
    this.failed = false
  }

  private async save(): Promise<void> {
    const state = this.projection()
    if (this.disposed || !state.available || !state.writable || !state.dirty || state.invalid || this.saving) return
    if (this.scope.getSnapshot().revision !== this.draftRevision) {
      this.conflicted = true
      this.publish()
      return
    }
    const desired = clone(this.value())
    const generation = this.generation
    this.saving = true
    this.failed = false
    this.publish()
    await this.scope.mutate([
      { op: 'set', path: ['defaultRoute'], value: desired.defaultRoute === null ? null : { ...desired.defaultRoute } },
      { op: 'set', path: ['employees'], value: desired.employees.map(employee => ({
        id: employee.id,
        name: employee.name,
        role: employee.role,
        route: employee.route === null ? null : { ...employee.route },
      })) },
    ], this.draftRevision)
    if (generation !== this.generation) return
    this.saving = false
    if (same(this.current(), desired)) this.clearDraft()
    else this.failed = true
    this.publish()
  }

  /** Refresh routes after adapter or settings directory changes. */
  refreshCatalog(): void {
    if (this.disposed) return
    this.catalogGeneration += 1
    this.catalogStatus = 'idle'
    if (this.scope.getSnapshot().status === 'ready') void this.loadCatalog()
    else this.publish()
  }

  /** Drop Host-specific drafts and catalog values after a connection reset. */
  resetConnection(): void {
    if (this.disposed) return
    this.generation += 1
    this.saving = false
    this.clearDraft()
    this.groups = []
    this.refreshCatalog()
  }

  private async loadCatalog(): Promise<void> {
    if (this.disposed || this.catalogStatus === 'loading') return
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.catalogPartial = false
    this.publish()
    const result = await this.ctx.remote.session.modelCatalog()
    if (generation !== this.catalogGeneration) return
    if (result.ok) {
      this.groups = result.value.groups
      this.catalogPartial = result.value.failures.length > 0
      this.catalogStatus = 'ready'
    } else this.catalogStatus = 'error'
    this.publish()
  }

  private projection(): EmployeesCardState {
    const snapshot = this.scope.getSnapshot()
    // Snapshot stores freeze nested values; keep the editable draft private.
    const value = clone(this.value())
    const invalid = value.employees.length > 24 || value.employees.some(employee =>
      !employee.name.trim() || employee.name.length > 48 || !employee.role.trim() || employee.role.length > 1200)
    return {
      ...value, available: snapshot.status === 'ready', writable: snapshot.writable,
      dirty: !same(this.current(), value), invalid, saving: this.saving, failed: this.failed,
      models: this.models(), catalogStatus: this.catalogStatus, catalogPartial: this.catalogPartial,
      conflicted: this.conflicted,
    }
  }

  private publish(): void { this.store.set(this.projection()) }
}
