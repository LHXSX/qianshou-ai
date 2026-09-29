/** Employee responsibilities and real provider/model routes for new tasks. */
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { employeeRouteKey } from './employees-card-controller.ts'
import type { EmployeeModelOption, EmployeesCardFace } from './employees-card-controller.ts'
import type {} from './slot-contract.ts'
import { PluginCard } from './PluginCard.tsx'
import css from './EmployeesCard.module.css'

/** Props injected by the settings card renderer. */
export type EmployeesCardProps = PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'> & InjectFace<EmployeesCardFace>

/**
 * Show a staged roster whose choices come from the current model directory.
 * @param props - The card snapshot, localized copy, and plain controller actions.
 * @returns The employee settings card.
 */
export function EmployeesCard(props: EmployeesCardProps) {
  const { t } = props
  const state = props.useEmployeesCard(snapshot => snapshot)
  const disabled = !state.writable || state.saving || state.conflicted
  const groups = new Map<string, { name: string; models: EmployeeModelOption[] }>()
  for (const model of state.models) {
    const group = groups.get(model.provider)
    if (group) group.models.push(model)
    else groups.set(model.provider, { name: model.providerName, models: [model] })
  }
  const routeOptions = (individual: boolean) => (
    <>
      <option value="">{t(individual ? 'employeesInheritTeam' : 'employeesInheritCeo')}</option>
      {[...groups].map(([provider, group]) => (
        <optgroup key={provider} label={`${group.name} · ${provider}`}>
          {group.models.map(model => (
            <option key={model.key} value={model.key} disabled={!model.available}>
              {`${model.modelName} · ${model.model}${model.available ? '' : ` · ${t('employeesUnavailable')}`}`}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  )
  return (
    <PluginCard
      t={t} titleKey="employeesTitle" descriptionKey="employeesDescription"
      state={{ ...state, invalid: state.invalid || state.conflicted || !state.writable }}
      onSave={props.save} onDiscard={props.discard}
    >
      <div className={css.content}>
        <div className={css.defaults}>
          <label className={css.field}>
            <span className={css.label}>{t('employeesTeamDefault')}</span>
            <select value={employeeRouteKey(state.defaultRoute)} disabled={disabled}
              className={css.select} onChange={(event) => { props.setRoute(null, event.target.value) }}>
              {routeOptions(false)}
            </select>
          </label>
          <p className={css.hint}>{t('employeesDefaultHint')}</p>
          <p className={css.hint}>{t('employeesInterfaceHint')}</p>
        </div>
        {state.catalogStatus === 'loading'
          ? <p className={css.hint} role="status">{t('employeesLoading')}</p> : null}
        {state.catalogStatus === 'error' || state.catalogPartial
          ? (
            <div className={css.notice} role="status">
              <span>{t(state.catalogStatus === 'error' ? 'employeesCatalogError' : 'employeesCatalogPartial')}</span>
              <Button variant="ghost" disabled={state.saving} onClick={props.retryCatalog}>{t('employeesRetry')}</Button>
            </div>
          ) : null}
        {state.catalogStatus === 'ready' && !state.models.some(model => model.available)
          ? <p className={css.hint}>{t('employeesNoModels')}</p> : null}
        <div className={css.rosterHeader}>
          <span className={css.count}>{t('employeesCount').replace('{count}', String(state.employees.length))}</span>
          <Button variant="outline" disabled={disabled || state.employees.length >= 24} onClick={props.addEmployee}>
            {t('employeesAdd')}
          </Button>
        </div>
        {state.employees.length === 0 ? <p className={css.empty}>{t('employeesEmpty')}</p> : null}
        <div className={css.grid}>
          {state.employees.map(employee => (
            <fieldset key={employee.id} className={css.employee} disabled={disabled}>
              <legend className={css.srOnly}>{employee.name || employee.id}</legend>
              <div className={css.identity}>
                <span className={css.avatar} aria-hidden="true">{employee.name.trim().slice(0, 1) || '·'}</span>
                <label className={css.name}>
                  <span className={css.label}>{t('employeesName')}</span>
                  <Input value={employee.name} maxLength={48}
                    onChange={(event) => { props.editEmployee(employee.id, 'name', event.target.value) }} />
                </label>
                <Button variant="ghost" className={css.remove} aria-label={`${t('employeesRemove')} ${employee.name || employee.id}`}
                  onClick={() => { props.removeEmployee(employee.id) }}>
                  {t('employeesRemove')}
                </Button>
              </div>
              <span className={css.identifier}>{t('employeesStableId')} · {employee.id}</span>
              <label className={css.field}>
                <span className={css.label}>{t('employeesRole')}</span>
                <textarea className={css.textarea} value={employee.role} maxLength={1200} rows={3}
                  placeholder={t('employeesRoleHint')}
                  onChange={(event) => { props.editEmployee(employee.id, 'role', event.target.value) }} />
              </label>
              <label className={css.field}>
                <span className={css.label}>{t('employeesRoute')}</span>
                <select className={css.select} value={employeeRouteKey(employee.route)}
                  onChange={(event) => { props.setRoute(employee.id, event.target.value) }}>
                  {routeOptions(true)}
                </select>
              </label>
            </fieldset>
          ))}
        </div>
        {state.employees.length >= 24 ? <p className={css.hint}>{t('employeesLimit')}</p> : null}
        {state.invalid ? <p className={css.invalid} role="status">{t('employeesInvalid')}</p> : null}
        {state.conflicted ? <p className={css.invalid} role="status">{t('employeesConflict')}</p> : null}
        <p className={css.changes}>{t('employeesChangesHint')}</p>
      </div>
    </PluginCard>
  )
}
