/** Searchable ability board scoped to the existing conversation composer. */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  IconChevronDownOutline14, IconPluginPinwheelOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MarketCapability, SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { QianshouKey } from './locales.ts'
import { canSelectConversationAbility } from './conversation-ability-catalog.ts'
import { abilitySubdivision } from './ability-taxonomy.ts'
import { conversationPluginDisplayTitle } from './conversation-plugin-display.ts'
import { SkillCover } from './SkillCover.tsx'
import css from './SkillSeat.module.css'

export const CATEGORIES = [
  'text', 'image', 'video', 'ppt', 'spreadsheet', 'research',
  'development', 'automation', 'design', 'data', 'other',
] as const

export type SkillCategory = typeof CATEGORIES[number]

export const CATEGORY_KEY_BY_TYPE = new Map<SkillCategory, QianshouKey>([
  ['text', 'skillCategoryText'], ['image', 'skillCategoryImage'], ['video', 'skillCategoryVideo'],
  ['ppt', 'skillCategoryPpt'], ['spreadsheet', 'skillCategorySpreadsheet'],
  ['research', 'skillCategoryResearch'], ['development', 'skillCategoryDevelopment'],
  ['automation', 'skillCategoryAutomation'], ['design', 'skillCategoryDesign'],
  ['data', 'skillCategoryData'], ['other', 'skillCategoryOther'],
])

const SUMMARY_KEY_BY_TYPE = new Map<SkillCategory, QianshouKey>([
  ['text', 'skillSummaryText'], ['image', 'skillSummaryImage'], ['video', 'skillSummaryVideo'],
  ['ppt', 'skillSummaryPpt'], ['spreadsheet', 'skillSummarySpreadsheet'],
  ['research', 'skillSummaryResearch'], ['development', 'skillSummaryDevelopment'],
  ['automation', 'skillSummaryAutomation'], ['design', 'skillSummaryDesign'],
  ['data', 'skillSummaryData'], ['other', 'skillSummaryOther'],
])

const KNOWN_SKILLS: Record<string, { category: SkillCategory; titleKey: QianshouKey; summaryKey: QianshouKey }> = {
  automate: { category: 'automation', titleKey: 'skillNameAutomate', summaryKey: 'skillAboutAutomate' },
  autopilot: { category: 'development', titleKey: 'skillNameAutopilot', summaryKey: 'skillAboutAutopilot' },
  canvas: { category: 'design', titleKey: 'skillNameCanvas', summaryKey: 'skillAboutCanvas' },
  'create-hook': { category: 'development', titleKey: 'skillNameCreateHook', summaryKey: 'skillAboutCreateHook' },
  'create-rule': { category: 'development', titleKey: 'skillNameCreateRule', summaryKey: 'skillAboutCreateRule' },
  'create-skill': { category: 'development', titleKey: 'skillNameCreateSkill', summaryKey: 'skillAboutCreateSkill' },
  'skill-creator': { category: 'development', titleKey: 'skillNameCreateSkill', summaryKey: 'skillAboutCreateSkill' },
  'create-subagent': { category: 'development', titleKey: 'skillNameCreateSubagent', summaryKey: 'skillAboutCreateSubagent' },
  'deploy-with-vercel': { category: 'development', titleKey: 'skillNameDeploy', summaryKey: 'skillAboutDeploy' },
  goal: { category: 'automation', titleKey: 'skillNameGoal', summaryKey: 'skillAboutGoal' },
  imagegen: { category: 'image', titleKey: 'skillNameImagegen', summaryKey: 'skillAboutImagegen' },
  loop: { category: 'automation', titleKey: 'skillNameLoop', summaryKey: 'skillAboutLoop' },
  'migrate-to-skills': { category: 'development', titleKey: 'skillNameMigrate', summaryKey: 'skillAboutMigrate' },
  'new-repo': { category: 'development', titleKey: 'skillNameNewRepo', summaryKey: 'skillAboutNewRepo' },
  'office-docx': { category: 'text', titleKey: 'skillNameDocx', summaryKey: 'skillAboutDocx' },
  'office-pptx': { category: 'ppt', titleKey: 'skillNamePptx', summaryKey: 'skillAboutPptx' },
  'office-xlsx': { category: 'spreadsheet', titleKey: 'skillNameXlsx', summaryKey: 'skillAboutXlsx' },
  onboard: { category: 'automation', titleKey: 'skillNameOnboard', summaryKey: 'skillAboutOnboard' },
  origin: { category: 'development', titleKey: 'skillNameOrigin', summaryKey: 'skillAboutOrigin' },
  'svg-to-video': { category: 'video', titleKey: 'skillNameSvgVideo', summaryKey: 'skillAboutSvgVideo' },
  'documents:documents': { category: 'text', titleKey: 'skillNameDocx', summaryKey: 'skillAboutDocx' },
  'presentations:Presentations': { category: 'ppt', titleKey: 'skillNamePptx', summaryKey: 'skillAboutPptx' },
  'spreadsheets:Spreadsheets': { category: 'spreadsheet', titleKey: 'skillNameXlsx', summaryKey: 'skillAboutXlsx' },
  'pdf:pdf': { category: 'text', titleKey: 'skillNamePdf', summaryKey: 'skillAboutPdf' },
  'visualize:visualize': { category: 'data', titleKey: 'skillNameVisualize', summaryKey: 'skillAboutVisualize' },
}

const CATEGORY_HINTS: readonly { category: SkillCategory; pattern: RegExp }[] = [
  { category: 'video', pattern: /video|film|animation|motion|gif|剪辑|视频|动画|动效/i },
  { category: 'ppt', pattern: /ppt|powerpoint|slide|presentation|幻灯|演示文稿/i },
  { category: 'spreadsheet', pattern: /spreadsheet|excel|xlsx|sheet|csv|表格|电子表/i },
  { category: 'image', pattern: /image|photo|picture|illustrat|绘图|图片|出图|图像/i },
  { category: 'design', pattern: /design|canvas|figma|logo|海报|排版|视觉设计/i },
  { category: 'text', pattern: /writ|docx|document|pdf|article|report|写作|文案|文档|公文|论文/i },
  { category: 'data', pattern: /data|chart|visualiz|分析|可视化|数据/i },
  { category: 'research', pattern: /research|search|browse|调研|搜索|检索|资料/i },
  { category: 'automation', pattern: /automat|schedule|remind|workflow|定时|提醒|自动化|工作流/i },
  { category: 'development', pattern: /code|coding|develop|plugin|sdk|repo|git|api|test|debug|编程|开发|代码|插件/i },
]

export function categoryOf(skill: SkillEntry): SkillCategory {
  if (CATEGORIES.some(category => category === skill.category)) return skill.category as SkillCategory
  const known = KNOWN_SKILLS[skill.name]
  if (known !== undefined) return known.category
  const byName = CATEGORY_HINTS.find(hint => hint.pattern.test(skill.name))
  if (byName !== undefined) return byName.category
  const description = `${skill.description} ${skill.whenToUse ?? ''}`
  return CATEGORY_HINTS.find(hint => hint.pattern.test(description))?.category ?? 'other'
}

/** Stable Chinese title for known installed skills, while preserving authored names. */
export function skillDisplayName(skill: SkillEntry, t: (key: QianshouKey) => string): string {
  const known = KNOWN_SKILLS[skill.name]
  return skill.displayName?.trim() || (known === undefined ? skill.name : t(known.titleKey))
}

function shortDescription(description: string): string {
  const firstSentence = description.trim().split(/[。！？\n]/u, 1)[0] ?? ''
  return firstSentence.length <= 42 ? firstSentence : `${firstSentence.slice(0, 41).trimEnd()}…`
}

export interface SkillSeatState {
  readonly skills: readonly SkillEntry[]
  readonly loading: boolean
  readonly error: boolean
}

/** An installed and active plugin row. Its tools still need Session verification. */
export interface ConversationPlugin {
  readonly id: string
  readonly title: string
  readonly description: string
}

export interface SkillSeatInjected {
  readonly hooks: { readonly skills: SnapshotStore<SkillSeatState> }
  readonly load: () => Promise<void>
  readonly reload: () => Promise<void>
  readonly selectSkill: (name: string) => boolean
  /** Compose the fixed buyer entry; its current contract is verified by the @ parser. */
  readonly composeCallEntry: (entry: 'image' | 'video') => boolean
  readonly listPlugins: () => Promise<readonly ConversationPlugin[]>
  readonly requestPlugin: (id: string, signal?: AbortSignal) => Promise<boolean>
  readonly listMarketAbilities: () => Promise<readonly MarketCapability[]>
  readonly selectMarketAbility: (taskType: string, expected?: Readonly<MarketCapability>, signal?: AbortSignal) => Promise<boolean>
  readonly abilitySelectionTimeoutMs: number
  readonly coverAtlasUrl?: string
}

type Props = PropsRuntime<'conversation.input.left'>
  & PropsLocale<'qianshou.brand'>
  & InjectFace<SkillSeatInjected>

type SourceFilter = 'all' | 'official' | 'user' | 'local' | 'plugins'

const SOURCE_FILTERS: readonly { value: SourceFilter; key: QianshouKey }[] = [
  { value: 'all', key: 'abilitySourceAll' }, { value: 'official', key: 'abilitySourceOfficial' },
  { value: 'user', key: 'abilitySourceUser' }, { value: 'local', key: 'abilitySourceLocal' },
  { value: 'plugins', key: 'installedPlugins' },
]

const MARKET_CATEGORY_ALIASES: Record<string, SkillCategory> = {
  writing: 'text', document: 'text', doc: 'text', pdf: 'text', translation: 'text',
  illustration: 'image', animation: 'video', presentation: 'ppt', code: 'development',
  search: 'research', analytics: 'data',
}

function marketCategory(item: MarketCapability): SkillCategory {
  return CATEGORIES.includes(item.category as SkillCategory) ? item.category as SkillCategory
    : MARKET_CATEGORY_ALIASES[item.category] ?? 'other'
}

/** Render a searchable ability board; selections only compose into the current draft. */
export function SkillSeat({ useSkills, load, reload, selectSkill, listPlugins, requestPlugin,
  listMarketAbilities, selectMarketAbility, composeCallEntry,
  abilitySelectionTimeoutMs, coverAtlasUrl, sessionId, useSessions, t }: Props) {
  const state = useSkills(value => value)
  const calling = useSessions(value => value.byId[sessionId]?.projectionValues?.agentPreset === 'qianshou-call')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<SourceFilter>('all')
  const [category, setCategory] = useState<SkillCategory | null>(null)
  const [subdivision, setSubdivision] = useState<string | null>(null)
  const [plugins, setPlugins] = useState<{
    items: readonly ConversationPlugin[]
    loading: boolean
    error: boolean
  }>({ items: [], loading: false, error: false })
  const [market, setMarket] = useState<{
    items: readonly MarketCapability[]
    loading: boolean
    error: boolean
  }>({ items: [], loading: false, error: false })
  const [selectionFailed, setSelectionFailed] = useState(false)
  const [checkingMarket, setCheckingMarket] = useState<string | null>(null)
  const selection = useRef<AbortController | null>(null)
  const selectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const request = useRef(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const board = useRef<HTMLDivElement>(null)

  useEffect(() => { void load() }, [load])
  useEffect(() => () => {
    request.current++; selection.current?.abort(); selection.current = null
    if (selectionTimer.current !== null) clearTimeout(selectionTimer.current)
  }, [])
  useEffect(() => {
    if (!open) return
    if (calling) board.current?.querySelector('button')?.focus()
    else search.current?.focus()
  }, [open, calling])
  useEffect(() => {
    if (!open) return
    const trapFocus = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const dialog = board.current?.closest('[role="dialog"]')
      const focusable = [...dialog?.querySelectorAll<HTMLElement>('*') ?? []]
        .filter(element => (element.tagName === 'BUTTON' || element.tagName === 'INPUT') && !element.matches(':disabled'))
      const first = focusable?.[0]
      const last = focusable?.[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', trapFocus)
    return () => { document.removeEventListener('keydown', trapFocus) }
  }, [open])

  const refresh = (reloadSkills = false): void => {
    const generation = ++request.current
    setPlugins(value => ({ ...value, loading: true, error: false }))
    setMarket(value => ({ ...value, loading: true, error: false }))
    void listPlugins().then((items) => {
      if (generation === request.current) setPlugins({ items, loading: false, error: false })
    }).catch(() => {
      if (generation === request.current) setPlugins(value => ({ ...value, loading: false, error: true }))
    })
    void listMarketAbilities().then((items) => {
      if (generation === request.current) setMarket({ items, loading: false, error: false })
    }).catch(() => {
      if (generation === request.current) setMarket(value => ({ ...value, loading: false, error: true }))
    })
    void (reloadSkills ? reload() : load())
  }
  const cancelSelection = (): void => {
    selection.current?.abort()
    if (selectionTimer.current !== null) clearTimeout(selectionTimer.current)
    selectionTimer.current = null
    selection.current = null
    setCheckingMarket(null)
  }
  const close = (): void => { cancelSelection(); setOpen(false); trigger.current?.focus() }
  const choose = (perform: (signal: AbortSignal) => Promise<boolean>, taskType?: string): void => {
    cancelSelection()
    const current = new AbortController()
    selection.current = current
    setCheckingMarket(taskType ?? null)
    setSelectionFailed(false)
    const timeout = setTimeout(() => {
      if (selection.current !== current) return
      current.abort()
      selection.current = null
      setCheckingMarket(null)
      setSelectionFailed(true)
    }, abilitySelectionTimeoutMs)
    selectionTimer.current = timeout
    void perform(current.signal).then((selected) => {
      if (selection.current !== current || current.signal.aborted) return
      if (selected) setOpen(false)
      else { setSelectionFailed(true); refresh(true) }
    }).catch(() => {
      if (selection.current === current && !current.signal.aborted) { setSelectionFailed(true); refresh(true) }
    }).finally(() => {
      clearTimeout(timeout)
      if (selection.current === current) { selection.current = null; setCheckingMarket(null) }
    })
  }

  const needle = query.trim().toLocaleLowerCase()
  const matches = (...texts: string[]): boolean => !needle
    || texts.some(text => text.toLocaleLowerCase().includes(needle))
  const sourceSkills = (source === 'all' || source === 'local') ? state.skills : []
  const sourceMarket = (source === 'all' || source === 'official' || source === 'user')
    ? market.items.filter(item => canSelectConversationAbility(item, market.items)
      && (source === 'all' || item.publisherKinds.includes(source))) : []
  const skillItems = sourceSkills.filter(skill =>
    (category === null || categoryOf(skill) === category)
    && (subdivision === null || abilitySubdivision(categoryOf(skill), `${skill.name} ${skillDisplayName(skill, t)}`, skill.description).id === subdivision)
    && matches(skill.name, skillDisplayName(skill, t), skill.description))
  const marketItems = sourceMarket.filter(item => (category === null || marketCategory(item) === category)
      && (subdivision === null || abilitySubdivision(marketCategory(item), item.name, item.description).id === subdivision)
      && matches(item.name, item.taskType, item.description, item.categoryLabelZh))
  const pluginItems = (source === 'all' || source === 'plugins') && category === null
    ? plugins.items.filter(item => matches(item.id, item.title, item.description)) : []
  const availableCategories = CATEGORIES.filter(value => sourceSkills.some(skill => categoryOf(skill) === value)
    || sourceMarket.some(item => marketCategory(item) === value))
  const subdivisions = new Map<string, QianshouKey>()
  if (category !== null) {
    for (const skill of sourceSkills.filter(item => categoryOf(item) === category)) {
      const value = abilitySubdivision(category, `${skill.name} ${skillDisplayName(skill, t)}`, skill.description)
      subdivisions.set(value.id, value.key)
    }
    for (const item of sourceMarket.filter(item => marketCategory(item) === category)) {
      const value = abilitySubdivision(category, item.name, item.description)
      subdivisions.set(value.id, value.key)
    }
  }
  const count = skillItems.length + marketItems.length + pluginItems.length

  if (calling) return <>
    <button type="button" ref={trigger} className={css.trigger} aria-haspopup="dialog"
      aria-expanded={open} aria-label={t('callingAbilityHint')} title={t('callingAbilityHint')}
      onClick={() => { setOpen(true); setSelectionFailed(false) }}>
      <IconPluginPinwheelOutline16 size={15} aria-hidden="true" />
      <span>{t('callingAbility')}</span>
      <IconChevronDownOutline14 className={css.chevron} aria-hidden="true" />
    </button>
    <Modal open={open} onClose={close} title={t('callingAbility')}
      closeLabel={t('abilityClose')} description={t('callingAbilityBoardDescription')}
      className={css.board ?? ''} contentClassName={css.boardContent ?? ''}>
      <div ref={board} className={css.boardBody}>
        <p>{t('callingAbilityBoardDescription')}</p>
        {selectionFailed && <p role="alert">{t('abilitySelectionFailed')}</p>}
        <div className={css.cards} role="list" aria-label={t('abilityResults')}>
          {(['image', 'video'] as const).map(entry => <article key={entry} role="listitem" className={css.card}>
            <SkillCover category={entry} atlasUrl={coverAtlasUrl} />
            <div className={css.cardHeading}><IconPluginPinwheelOutline16 aria-hidden="true" />
              <strong>{t(entry === 'image' ? 'callingImage' : 'callingVideo')}</strong></div>
            <p className={css.description}>{t(entry === 'image'
              ? 'callingImageDescription' : 'callingVideoDescription')}</p>
            <button type="button" className={css.select} onClick={() => {
              if (composeCallEntry(entry)) close()
              else setSelectionFailed(true)
            }}>{t('abilitySelect')}</button>
          </article>)}
        </div>
      </div>
    </Modal>
  </>

  return <>
    <button type="button" ref={trigger} className={css.trigger} aria-haspopup="dialog"
      aria-expanded={open} aria-label={t(calling ? 'callingAbilityHint' : 'skillsHint')}
      title={t(calling ? 'callingAbilityHint' : 'skillsHint')}
      onClick={() => {
        setQuery(''); setSource('all'); setCategory(null); setSubdivision(null); setSelectionFailed(false)
        refresh(); setOpen(true)
      }}>
      <IconPluginPinwheelOutline16 size={15} aria-hidden="true" />
      <span>{t(calling ? 'callingAbility' : 'skills')}</span>
      <IconChevronDownOutline14 className={css.chevron} aria-hidden="true" />
    </button>
    <Modal open={open} onClose={close} title={t('skillsMenuTitle')} closeLabel={t('abilityClose')}
      description={t('abilityBoardDescription')} className={css.board ?? ''} contentClassName={css.boardContent ?? ''}>
      <div ref={board} className={css.boardBody}>
        <input ref={search} className={css.search} type="search" value={query}
          aria-label={t('abilitySearch')} placeholder={t('abilitySearch')}
          onChange={(event) => { setQuery(event.target.value) }} />
        <div className={css.filters} role="group" aria-label={t('abilitySourceFilter')}>
          {SOURCE_FILTERS.map(filter => <button key={filter.value} type="button"
            aria-pressed={source === filter.value} className={css.filter}
            onClick={() => { setSource(filter.value); setCategory(null); setSubdivision(null) }}>{t(filter.key)}</button>)}
        </div>
        {source !== 'plugins' ? <div className={css.filters} role="group" aria-label={t('abilityCategoryFilter')}>
          <span className={css.filterLabel}>{t('abilityCategoryFilter')}</span>
          <button type="button" aria-pressed={category === null} className={css.filter}
            onClick={() => { setCategory(null); setSubdivision(null) }}>{t('abilityCategoryAll')}</button>
          {availableCategories.map(value => <button key={value} type="button" className={css.filter}
            aria-pressed={category === value} onClick={() => { setCategory(value); setSubdivision(null) }}>
            {t(CATEGORY_KEY_BY_TYPE.get(value) ?? 'skillCategoryOther')}</button>)}
        </div> : null}
        {category !== null ? <div className={css.filters} role="group" aria-label={t('abilitySubdivisionFilter')}>
          <span className={css.filterLabel}>{t('abilitySubdivisionFilter')}</span>
          <button type="button" aria-pressed={subdivision === null} className={css.filter}
            onClick={() => { setSubdivision(null) }}>{t('abilitySubdivisionAll')}</button>
          {[...subdivisions].map(([id, key]) => <button key={id} type="button" className={css.filter}
            aria-pressed={subdivision === id} onClick={() => { setSubdivision(id) }}>{t(key)}</button>)}
        </div> : null}
        <div className={css.status} aria-live="polite">
          {(source === 'all' || source === 'local') && (state.loading || state.error)
            ? <p>{t(state.error ? 'skillsUnavailable' : 'skillsLoading')}</p> : null}
          {(source === 'all' || source === 'plugins') && (plugins.loading || plugins.error)
            ? <p>{t(plugins.error ? 'pluginsUnavailable' : 'pluginsLoading')}</p> : null}
          {(source === 'all' || source === 'official' || source === 'user') && (market.loading || market.error)
            ? <p>{t(market.error ? 'abilityMarketUnavailable' : 'abilityMarketLoading')}</p> : null}
          {selectionFailed ? <p role="alert">{t('abilitySelectionFailed')}</p> : null}
        </div>
        <div className={css.cards} role="list" aria-label={t('abilityResults')}>
          {marketItems.map(item => <article key={`market:${item.taskType}`} role="listitem" className={css.card}>
            <SkillCover category={item.category === 'legal' ? 'legal' : marketCategory(item)} atlasUrl={coverAtlasUrl} />
            <div className={css.cardHeading}><IconPluginPinwheelOutline16 aria-hidden="true" />
              <strong>{item.name}</strong></div>
            <div className={css.badges}>{item.publisherKinds.map(kind => <span key={kind} className={css.badge}>
              {t(kind === 'official' ? 'abilitySourceOfficial' : 'abilitySourceUser')}</span>)}
            {(item.publisherKinds.length === 1 ? item.publisherKinds : []).flatMap((kind) => {
              const keys: QianshouKey[] = []
              if (item.products.some(product => product.availableToPurchase && Number(product.salePriceYuan) === 0))
                keys.push(kind === 'official' ? 'abilityOfficialFreeProduct' : 'abilityUserFreeProduct')
              if (item.products.some(product => Number(product.salePriceYuan) > 0))
                keys.push(kind === 'official' ? 'abilityOfficialPaidProduct' : 'abilityUserPaidProduct')
              return keys.map(key => <span key={key} className={css.badge}>{t(key)}</span>)
            })}</div>
            <details className={css.technical}><summary>{t('abilityTechnicalDetails')}</summary>
              <span className={css.code}>{item.taskType}</span></details>
            <p className={css.description}>{item.description}</p>
            <div className={css.price}>{t('abilityExecutionQuote')}</div>
            {item.products.map(product => <div key={`${product.productId}:${product.version}`} className={css.salePrice}>
              {t('abilityProductBuyout')} · ¥{product.salePriceYuan} · {product.version}</div>)}
            <button type="button" className={css.select} disabled={checkingMarket === item.taskType || market.error || !canSelectConversationAbility(item, market.items)}
              aria-busy={checkingMarket === item.taskType}
              onClick={() => { choose(signal => selectMarketAbility(item.taskType, item, signal), item.taskType) }}>
              {t(checkingMarket === item.taskType ? 'abilityValidating'
                : canSelectConversationAbility(item, market.items) ? 'abilitySelect' : 'abilityNotCallable')}</button>
          </article>)}
          {skillItems.map((skill) => {
            const known = KNOWN_SKILLS[skill.name]
            const summary = /[\u3400-\u9fff]/u.test(skill.description)
              ? shortDescription(skill.description) : known === undefined
                ? shortDescription(skill.description) || t(SUMMARY_KEY_BY_TYPE.get(categoryOf(skill)) ?? 'skillSummaryOther') : t(known.summaryKey)
            return <article key={`skill:${skill.name}`} role="listitem" className={css.card}>
              <SkillCover category={/legal|法律|法务/u.test(`${skill.name} ${skill.description}`)
                ? 'legal' : categoryOf(skill)} atlasUrl={coverAtlasUrl} />
              <div className={css.cardHeading}><IconPluginPinwheelOutline16 aria-hidden="true" />
                <strong>{skillDisplayName(skill, t)}</strong></div>
              <div className={css.badges}><span className={css.badge}>{t('abilitySourceLocal')}</span></div>
              <details className={css.technical}><summary>{t('abilityTechnicalDetails')}</summary>
                <span className={css.code}>/{skill.name}</span></details>
              <p className={css.description}>{summary}</p>
              <div className={css.price}>{t('abilityLocalCostUnknown')}</div>
              <button type="button" className={css.select} disabled={state.error} onClick={() => {
                cancelSelection()
                if (selectSkill(skill.name)) setOpen(false)
                else setSelectionFailed(true)
              }}>{t('abilitySelect')}</button>
            </article>
          })}
          {pluginItems.map(plugin => <article key={`plugin:${plugin.id}`} role="listitem" className={css.card}>
            <SkillCover category={/legal|法律|法务/u.test(`${plugin.title} ${plugin.description}`) ? 'legal'
              : categoryOf({ name: plugin.title, description: plugin.description,
                modelInvocable: false })} atlasUrl={coverAtlasUrl} />
            <div className={css.cardHeading}><IconPluginPinwheelOutline16 aria-hidden="true" />
              <strong>{conversationPluginDisplayTitle(plugin.title, plugin.description, t('installedPlugins'))}</strong></div>
            <div className={css.badges}><span className={css.badge}>{t('installedPlugins')}</span></div>
            <p className={css.description}>{shortDescription(plugin.description) || t('pluginBorrowNoDescription')}</p>
            <div className={css.price}>{t('abilityLocalCostUnknown')}</div>
            <details className={css.technical}><summary>{t('abilityTechnicalDetails')}</summary>
              {conversationPluginDisplayTitle(plugin.title, plugin.description, t('installedPlugins')) !== plugin.title
                ? <span className={css.code}>{plugin.title}</span> : null}
              <span className={css.code}>{plugin.id}</span></details>
            <button type="button" className={css.select} disabled={checkingMarket === `plugin:${plugin.id}` || plugins.error}
              aria-busy={checkingMarket === `plugin:${plugin.id}`}
              onClick={() => { choose(signal => requestPlugin(plugin.id, signal), `plugin:${plugin.id}`) }}>
              {t(checkingMarket === `plugin:${plugin.id}` ? 'abilityValidating' : 'pluginBorrowAction')}</button>
          </article>)}
        </div>
        {count === 0 && !state.loading && !plugins.loading && !market.loading
          ? <p className={css.empty}>{t('abilityNoMatches')}</p> : null}
        <p className={css.note}>{source === 'plugins' ? t('pluginBorrowExplanation') : t('abilityBoardNote')}</p>
        <button type="button" className={css.refresh} onClick={() => { cancelSelection(); refresh(true) }}>{t('refresh')}</button>
      </div>
    </Modal>
  </>
}
