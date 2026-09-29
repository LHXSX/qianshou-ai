/**
 * 模型路由控制台（设置页里的管理面板）。
 *
 * 这个面板只做四件事：看当前目录、看每个名字的绑定历史（含已失效的）、
 * 看可选后端键位、**追加一条未来生效的绑定**。它不做的事同样是设计：
 *
 * - **没有「编辑现有绑定」**。绑定只追加，改历史等于让过去的账单不可解释。
 * - **没有「立刻生效」**。生效时刻是显式选择（24 小时 / 3 天 / 7 天 / 自定义），
 *   低于当前时刻或低于上一条绑定的时刻会在**提交前**被挡住并说明原因。
 * - **不显示上游标识**。可用后端只露键位与并发数，并写明「用户看不到这一层」。
 * - **不伪造历史**。接口没给这个名字的历史时，这里说「接口没有返回」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Pill, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RouteConsoleController, RouteConsoleState, RouteFailure } from './controller.ts'
import type { RoutingKey } from './locales.ts'
import {
  bindingPhase, formatEffectiveFrom, fromLocalInputValue, latestBindingAt, moveBackend,
  parseRolloutPercent, presetEffectiveFrom, removeBackend, seedBackendKeys,
  validateBindRequest, type BackendBinding, type EffectivePreset, type LifecycleStage,
  type RouteCatalog, type UpgradeRule,
} from './route-catalog.ts'
import css from './RoutingConsoleSection.module.css'

/** 面板依赖（插槽 `inject`）。 */
export interface RoutingConsoleInjected {
  /** 控制台会话（读取目录、追加绑定）。 */
  controller: RouteConsoleController
  hooks: {
    /** 目录快照，渲染器绑定成 `useCatalog`。 */
    catalog: RouteConsoleController['store']
  }
  refresh: () => Promise<void>
  bind: RouteConsoleController['bind']
  /** 面板文案（注入进来，组件不碰 ctx）。 */
  t: (key: RoutingKey, values?: Record<string, string>) => string
}

/** 面板的组件 props：注入面 + 设置 shell 的 owner 分享。 */
export type RoutingConsoleSectionProps = Partial<InjectFace<RoutingConsoleInjected>> & PropsLocale<undefined> & {
  /** shell 提供的关闭动作；本面板不使用（没有离开设置页的流程）。 */
  close?: () => void
}

/** 表单里的一个生效时刻选择。 */
interface EffectiveChoice {
  readonly preset: EffectivePreset
  /** 自定义模式下的本机时刻文本。 */
  readonly custom: string
}

/** 生命周期阶段到文案键。 */
const STAGE_KEYS: Record<LifecycleStage, RoutingKey> = {
  preview: 'stagePreview', ga: 'stageGa', legacy: 'stageLegacy', deprecated: 'stageDeprecated', retired: 'stageRetired',
}
/** 升级策略到文案键。 */
const RULE_KEYS: Record<UpgradeRule, RoutingKey> = {
  'follow-default': 'ruleFollowDefault', 'on-expiry': 'ruleOnExpiry', never: 'ruleNever',
}
/** 绑定状态到文案键与色板。 */
const PHASE_LABELS = {
  active: { key: 'active', tone: 'success' },
  scheduled: { key: 'scheduled', tone: 'info' },
  retired: { key: 'retired', tone: 'quiet' },
} as const satisfies Record<ReturnType<typeof bindingPhase>, { key: RoutingKey; tone: 'success' | 'info' | 'quiet' }>
/** 预设列表（顺序即界面顺序）。 */
const PRESETS: readonly EffectivePreset[] = ['in-24h', 'in-3d', 'in-7d', 'custom']
/** 当前时刻（本地渲染锚点）。 */
function nowMs(): number {
  return Date.now()
}

/**
 * 设置页里的模型路由控制台。
 * @param props - 注入面（目录快照、刷新、追加入口、文案）。
 * @returns 面板元素。
 */
export function RoutingConsoleSection(props: RoutingConsoleSectionProps) {
  const t = props.t ?? ((key: RoutingKey) => key)
  const state = props.useCatalog?.(snapshot => snapshot) as RouteConsoleState | undefined
  const [choice, setChoice] = useState<EffectiveChoice>({ preset: 'in-24h', custom: '' })
  const [publishedName, setPublishedName] = useState('')
  const [backendKeys, setBackendKeys] = useState<readonly string[]>([])
  const [rollout, setRollout] = useState('100')
  const [reason, setReason] = useState('')
  const [invalid, setInvalid] = useState<string | null>(null)
  const [added, setAdded] = useState(false)
  /** 本组件自己的提交闸门：控制器发布 `submitting` 之前的同一次渲染里也要挡住第二次点击。 */
  const [pending, setPending] = useState(false)
  const submitting = useRef(false)
  const refresh = props.refresh
  const bind = props.bind
  const binding = state?.submitting === true || pending

  useEffect(() => {
    if (refresh !== undefined) void refresh()
  }, [refresh])

  const catalog: RouteCatalog | null = state?.catalog ?? null
  // 「现在」在渲染期间固定：预设时刻与预览不能随每次重渲染漂移。
  const [anchor] = useState(nowMs)
  const now = nowMs()
  const effectiveFrom = useMemo(
    () => resolveEffectiveFrom(choice, catalog, publishedName, anchor),
    [choice, catalog, publishedName, anchor],
  )
  const clearNotices = useCallback((): void => { setInvalid(null); setAdded(false) }, [])

  const pickName = useCallback((name: string): void => {
    setPublishedName(name)
    setBackendKeys(catalog === null ? [] : seedBackendKeys(catalog, name, nowMs()))
    clearNotices()
  }, [catalog, clearNotices])

  async function submit(): Promise<void> {
    if (submitting.current || binding || catalog === null || bind === undefined) return
    const draft = { publishedName, backendKeys, rolloutPercent: rollout, reason }
    const check = validateBindRequest(draft, catalog, effectiveFrom ?? Number.NaN, nowMs())
    if (!check.ok) {
      setInvalid(check.message)
      setAdded(false)
      return
    }
    submitting.current = true
    setPending(true)
    try {
      const ok = await bind(check.request)
      setInvalid(null)
      setAdded(ok)
      if (ok) setReason('')
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  const name = catalog?.names.find(item => item.publishedName === publishedName)
  const floor = name === undefined ? null : latestBindingAt(name.history)
  const backends = catalog?.backends ?? []
  const percent = parseRolloutPercent(rollout)
  const ready = catalog !== null && catalog.names.length > 0 && backends.length > 0

  return <section className={css.panel} aria-label={t('nav')}>
    <header className={css.header}>
      <div>
        <span className={css.eyebrow}>{t('eyebrow')}</span>
        <h1>{t('heading')}</h1>
        <p>{t('description')}</p>
      </div>
      <Button onClick={() => { void props.refresh?.() }} disabled={state?.loading === true || binding}>{t('refresh')}</Button>
    </header>

    {state?.readError != null && <Failure failure={state.readError} t={t} />}
    {state?.bindError != null && <Failure failure={state.bindError} t={t} />}
    {state?.loading === true && <p className={css.hint}>{t('loading')}</p>}

    <section className={css.block} aria-label={t('directory')}>
      <h2>{t('directory')}</h2>
      <p className={css.hint}>{t('directoryHint')}</p>
      {catalog !== null && catalog.names.length === 0 && <div className={css.empty}>
        <strong>{t('noNames')}</strong>
        <p>{t('noNamesHint')}</p>
      </div>}
      <div className={css.nameGrid}>
        {(catalog?.names ?? []).map(item => <article key={item.publishedName} className={css.nameCard}>
          <div className={css.nameHeading}>
            <strong>{item.label}</strong>
            <Tag tone={item.lifecycleStage === 'retired' ? 'danger' : 'outline'}>{t(STAGE_KEYS[item.lifecycleStage])}</Tag>
          </div>
          <dl className={css.facts}>
            <div><dt>{t('tiers')}</dt><dd>{item.tiers.map(tier => <Tag key={tier} tone="neutral">{tier}</Tag>)}</dd></div>
            <div><dt>{t('outputLimit')}</dt><dd>{t('tokens', { count: String(item.maxOutputTokens) })}</dd></div>
            <div><dt>{t('upgradeRule')}</dt><dd>{t(RULE_KEYS[item.upgradeRule])}</dd></div>
            {item.shutdownDate !== null && <div><dt>{t('shutdown')}</dt><dd>{formatEffectiveFrom(item.shutdownDate)}</dd></div>}
            {item.migrationTarget !== null && <div><dt>{t('migrationTarget')}</dt><dd>{item.migrationTarget}</dd></div>}
          </dl>
          <h3 className={css.subheading}>{t('history')}</h3>
          <p className={css.hint}>{t('historyHint')}</p>
          {item.history.length === 0
            ? <div className={css.empty}>
              <strong>{t('noHistory')}</strong>
              <p>{t('noHistoryHint')}</p>
            </div>
            : <BindingRows history={item.history} now={now} t={t} />}
        </article>)}
      </div>
    </section>

    <section className={css.block} aria-label={t('backends')}>
      <h2>{t('backends')}</h2>
      <p className={css.hint}>{t('backendsHint')}</p>
      {backends.length === 0
        ? <p className={css.hint}>{t('noBackends')}</p>
        : <table className={css.table}>
          <thead><tr><th>{t('backendKey')}</th><th>{t('concurrency')}</th></tr></thead>
          <tbody>{backends.map(backend => <tr key={backend.key}>
            <td><code>{backend.key}</code></td>
            <td>{t('concurrencyValue', { count: String(backend.concurrency) })}</td>
          </tr>)}</tbody>
        </table>}
    </section>

    <section className={css.block} aria-label={t('compose')}>
      <h2>{t('compose')}</h2>
      <p className={css.hint}>{t('composeHint')}</p>
      <form className={css.form} onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <fieldset className={css.fieldset} disabled={!ready || binding}>
          <label className={css.field}>{t('publishedName')}
            <select aria-label={t('publishedName')} value={publishedName} onChange={(event) => { pickName(event.target.value) }}>
              <option value="">{t('selectName')}</option>
              {catalog?.names.map(item => <option key={item.publishedName} value={item.publishedName}>{item.label}</option>)}
            </select>
          </label>

          <div className={css.orderBox}>
            <span className={css.fieldLabel}>{t('backendOrder')}</span>
            <ol className={css.orderList} aria-label={t('backendOrder')}>
              {backendKeys.map((key, index) => <li key={key} className={css.orderRow}>
                <span className={css.orderIndex}>{index + 1}</span>
                <code>{key}</code>
                {index === 0 && <Tag tone="info">{t('primaryTag')}</Tag>}
                <span className={css.orderActions}>
                  <button type="button" aria-label={`${key} ${t('orderUp')}`} disabled={index === 0}
                    onClick={() => { setBackendKeys(keys => moveBackend(keys, index, -1)); clearNotices() }}>↑</button>
                  <button type="button" aria-label={`${key} ${t('orderDown')}`} disabled={index === backendKeys.length - 1}
                    onClick={() => { setBackendKeys(keys => moveBackend(keys, index, 1)); clearNotices() }}>↓</button>
                  <button type="button" aria-label={`${key} ${t('removeBackend')}`}
                    onClick={() => { setBackendKeys(keys => removeBackend(keys, key)); clearNotices() }}>✕</button>
                </span>
              </li>)}
            </ol>
            <p className={css.hint}>{t('spillOrder')}</p>
            <div className={css.chips}>
              {backends.filter(backend => !backendKeys.includes(backend.key)).map(backend => <Pill key={backend.key}
                aria-label={`${t('backendKey')} ${backend.key}`}
                onClick={() => { setBackendKeys(keys => [...keys, backend.key]); clearNotices() }}>+ {backend.key}</Pill>)}
            </div>
          </div>

          <div className={css.timeBox}>
            <span className={css.fieldLabel}>{t('effectiveFrom')}</span>
            <div className={css.presets}>
              {PRESETS.map(preset => <Pill key={preset} active={choice.preset === preset}
                onClick={() => { setChoice(current => ({ ...current, preset })); clearNotices() }}>
                {t(preset === 'in-24h' ? 'preset24h' : preset === 'in-3d' ? 'preset3d' : preset === 'in-7d' ? 'preset7d' : 'presetCustom')}
              </Pill>)}
            </div>
            {choice.preset === 'custom' && <label className={css.field}>{t('customTime')}
              <Input aria-label={t('customTime')} type="datetime-local" value={choice.custom}
                onChange={(event) => { setChoice({ preset: 'custom', custom: event.target.value }); clearNotices() }} />
              <span className={css.hint}>{t('customTimeHint')}</span>
            </label>}
            <p className={css.preview}>{previewText({
              catalog, publishedName, name: name?.label ?? publishedName, effectiveFrom, floor, t,
            })}</p>
            <p className={css.hint}>{t('appendBoundary')}</p>
          </div>

          <label className={css.field}>{t('rolloutPercent')}
            <Input aria-label={t('rolloutPercent')} inputMode="numeric" value={rollout}
              onChange={(event) => { setRollout(event.target.value); clearNotices() }} />
            <span className={css.hint}>{t('rolloutHint')}</span>
            {percent === 0 && <span className={css.hint}>{t('rolloutZero')}</span>}
            {percent !== null && percent > 0 && percent < 100 && <span className={css.hint}>{t('rolloutPartial', { percent: String(percent) })}</span>}
          </label>

          <label className={css.field}>{t('formReason')}
            <textarea aria-label={t('formReason')} rows={3} value={reason} maxLength={500}
              onChange={(event) => { setReason(event.target.value); clearNotices() }} />
          </label>

          {invalid !== null && <p role="alert" className={css.invalid}>{invalid}</p>}
          {added && state?.bindError == null && <p className={css.added} role="status">{t('added')}</p>}
          <Button type="submit" variant="primary" disabled={!ready || binding}>{t(binding ? 'appending' : 'appendBinding')}</Button>
        </fieldset>
      </form>
      {state?.lastAppended != null && <section className={css.lastAppended} aria-label={t('history')}>
        <h3>{t('history')} · {state.lastAppended.publishedName}</h3>
        <BindingRows history={state.lastAppended.history} now={now} t={t} />
      </section>}
    </section>
  </section>
}

/** 失败提示块：分类文案 + 服务端原话。 */
function Failure({ failure, t }: { failure: RouteFailure; t: RoutingConsoleInjected['t'] }) {
  return <div className={css.error} role="alert">
    <strong>{t('error')}</strong>
    <p>{t(failure.key)}</p>
    {failure.message.length > 0 && <p>{failure.message}</p>}
  </div>
}

/** 历史行：生效区间、后端顺序、灰度、操作者、原因。 */
function BindingRows(props: { history: readonly BackendBinding[]; now: number; t: RoutingConsoleInjected['t'] }) {
  return <ol className={css.bindingList}>
    {props.history.map(binding => {
      const label = PHASE_LABELS[bindingPhase(binding, props.now)]
      return <li key={`${binding.effectiveFrom}-${binding.backendKeys.join('>')}`} className={css.binding}
        data-phase={bindingPhase(binding, props.now)}>
        <div className={css.bindingHeading}>
          <Tag tone={label.tone}>{props.t(label.key)}</Tag>
          <span className={css.range}>{formatEffectiveFrom(binding.effectiveFrom)} → {binding.effectiveTo === null
            ? props.t('untilFurther')
            : formatEffectiveFrom(binding.effectiveTo)}</span>
        </div>
        <p className={css.bindingKeys}>{props.t('backendOrder')}：{binding.backendKeys.map((key, index) => <span key={key}>
          {index > 0 && ' → '}<code>{key}</code>
        </span>)}</p>
        <dl className={css.facts}>
          <div><dt>{props.t('rollout')}</dt><dd>{binding.rolloutPercent === 100 ? props.t('rolloutFull') : `${binding.rolloutPercent}%`}</dd></div>
          <div><dt>{props.t('operator')}</dt><dd>{binding.operator}</dd></div>
          <div><dt>{props.t('reasonLabel')}</dt><dd>{binding.reason}</dd></div>
        </dl>
      </li>
    })}
  </ol>
}

/** 生效预览：说清哪一刻生效、上一条会在何时被钉住，或这是第一条。 */
function previewText(input: {
  catalog: RouteCatalog | null
  publishedName: string
  name: string
  effectiveFrom: number | null
  floor: number | null
  t: RoutingConsoleInjected['t']
}): string {
  if (input.catalog === null || input.publishedName.length === 0 || input.effectiveFrom === null) return input.t('previewInvalid')
  const when = formatEffectiveFrom(input.effectiveFrom)
  const line = input.t('previewLine', { when, name: input.name })
  return input.floor === null
    ? `${line} ${input.t('previewFirst', { name: input.name })}`
    : `${line} ${input.t('previewSeal', { from: formatEffectiveFrom(input.floor) })}`
}

/** 把生效选择落成毫秒；自定义文本非法或未选名字时返回 `null`。 */
function resolveEffectiveFrom(choice: EffectiveChoice, catalog: RouteCatalog | null, publishedName: string, anchor: number): number | null {
  if (catalog === null || publishedName.length === 0) return null
  if (choice.preset !== 'custom') return presetEffectiveFrom(choice.preset, anchor)
  return choice.custom.length === 0 ? null : fromLocalInputValue(choice.custom)
}
