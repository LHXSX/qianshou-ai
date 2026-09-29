/** User-owned employee roster and LLM routing; credentials stay in provider settings. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import { AllowedModelRouteSchema, type AllowedModelRoute } from './model-selection.ts'

/** One persistent employee role, with an optional independently assigned route. */
export interface Employee {
  id: string
  name: string
  role: string
  /** null follows the team's default route. */
  route: AllowedModelRoute | null
}

/** Team preferences sampled for every new delegation, never applied to running employees. */
export interface EmployeeSettings {
  /** null follows the CEO's current conversation route. */
  defaultRoute: AllowedModelRoute | null
  employees: Employee[]
}

/** Settings namespace consumed by the employee card. */
export const EMPLOYEE_SETTINGS_NAMESPACE = 'qianshou-employees'
const routeSchema = z.union([AllowedModelRouteSchema, z.const(null)]).default(null)
const employeeSchema: z<Employee> = z.object({
  id: z.string().min(1).max(48).required(),
  name: z.string().min(1).max(48).required(),
  role: z.string().min(1).max(1200).required(),
  route: routeSchema,
})

/** Initial roles describe responsibilities rather than fictional running workers. */
export const DEFAULT_EMPLOYEES: Employee[] = [
  { id: 'product', name: '产品经理', role: '梳理真实需求、用户场景、优先级、产品方案与验收标准。', route: null },
  { id: 'design', name: '设计师', role: '负责界面、交互、视觉、配色与可访问性，交付可实现的设计方案。', route: null },
  { id: 'engineer', name: '工程师', role: '阅读现有代码，模块化实现功能，完成必要测试并说明验证证据。', route: null },
  { id: 'reviewer', name: '测试审校', role: '独立复核功能、逻辑、安全与交付物，区分验证事实与待验证事项。', route: null },
  { id: 'writer', name: '写作员工', role: '根据目标读者、主题、用途与风格撰写和润色文章，核对事实并标明待核实内容。', route: null },
]

/** Validated schema exposed to revision-fenced user settings. */
export const EMPLOYEE_SETTINGS_SCHEMA: z<EmployeeSettings> = z.object({
  defaultRoute: routeSchema,
  employees: z.array(employeeSchema).default(DEFAULT_EMPLOYEES),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User-owned routing authority used only by opted-in employee tools. */
    employeeSettings: EmployeeSettingsService
  }
}

/**
 * Reject malformed ids/routes, undeclared fields and unbounded roster growth at the settings boundary.
 * @param value - Schema-admitted team preferences to validate before persistence.
 */
export function validateEmployeeSettings(value: EmployeeSettings): void {
  const checkFields = (entry: object, allowed: readonly string[]): void => {
    if (Object.keys(entry).some(key => !allowed.includes(key))) {
      throw new Error('employee settings contain unsupported fields; credentials belong in provider settings')
    }
  }
  checkFields(value, ['defaultRoute', 'employees'])
  if (value.employees.length > 24) throw new Error('employee roster supports at most 24 employees')
  const ids = new Set<string>()
  const checkRoute = (route: AllowedModelRoute | null): void => {
    if (route !== null) checkFields(route, ['provider', 'model'])
    if (route !== null && (!route.provider.trim() || !route.model.trim()
      || route.provider.includes('\0') || route.model.includes('\0'))) {
      throw new Error('employee route requires non-empty provider and model ids')
    }
  }
  checkRoute(value.defaultRoute)
  for (const employee of value.employees) {
    checkFields(employee, ['id', 'name', 'role', 'route'])
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(employee.id) || ids.has(employee.id)) {
      throw new Error('employee ids must be unique lowercase names with optional hyphens')
    }
    if (!employee.name.trim() || !employee.role.trim()) throw new Error('employee name and role cannot be blank')
    ids.add(employee.id)
    checkRoute(employee.route)
  }
}

/** Detached resolved assignment, safe to include in tool results without credentials. */
export interface EmployeeAssignment {
  employee: Employee
  route: AllowedModelRoute | null
  source: 'employee' | 'team' | 'ceo'
}

/** Host-owned routing service; settings edits affect subsequent dispatches only. */
export class EmployeeSettingsService extends Service {
  private source: () => EmployeeSettings

  constructor(ctx: Context) {
    super(ctx, 'employeeSettings')
    this.source = () => ({ defaultRoute: null, employees: DEFAULT_EMPLOYEES })
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, EMPLOYEE_SETTINGS_NAMESPACE,
        EMPLOYEE_SETTINGS_SCHEMA, this.current(), {
          setSource: (source) => { this.source = source },
          validate: validateEmployeeSettings,
          onChange: () => {},
        })
    })
  }

  /**
   * Read current role and route preferences without exposing the mutable settings source.
   * @returns A detached, credential-free roster snapshot.
   */
  current(): EmployeeSettings {
    return structuredClone(this.source())
  }

  /**
   * Resolve one employee against the latest user-owned team preferences.
   * @param id - Exact stable employee id returned by list_employees.
   * @returns The selected role, route and inheritance source.
   */
  resolve(id: string): EmployeeAssignment {
    const settings = this.current()
    const employee = settings.employees.find(candidate => candidate.id === id)
    if (!employee) throw new Error(`unknown employee "${id}"; call list_employees again`)
    return {
      employee,
      route: employee.route ?? settings.defaultRoute,
      source: employee.route !== null ? 'employee' : settings.defaultRoute !== null ? 'team' : 'ceo',
    }
  }
}

export const name = 'employee-settings'
export default EmployeeSettingsService
