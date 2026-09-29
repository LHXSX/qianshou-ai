// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalSkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { CapabilitiesPanel, type CapabilitiesPanelProps } from '../src/client/CapabilitiesPanel.tsx'
import {
  type CapabilitiesView, type MyCapability,
} from '../src/client/capabilities-controller.ts'
import { en, zh, type CapabilityKey } from '../src/client/capability-locales.ts'
import { zh as localSkillZh } from '../src/client/local-skill-locales.ts'
import { zh as localCandidateZh } from '../src/client/local-plugin-candidate-locales.ts'
import type { LocalPluginCandidateView } from '../src/client/local-plugin-candidates-controller.ts'
import { en as marketEn, type MarketplaceKey } from '../src/client/marketplace-locales.ts'
import type { PreflightReportView } from '../src/client/marketplace-controller.ts'

afterEach(cleanup)

const GIB = 1024 ** 3

function translate(dict: Record<CapabilityKey, string>): CapabilitiesPanelProps['t'] {
  return (key, params) => Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    dict[key],
  )
}

const t = translate(en)
const marketT = (key: MarketplaceKey): string => marketEn[key]

function capability(overrides: Partial<MyCapability> = {}): MyCapability {
  return {
    record: {
      id: 'qianshou.article', capabilityId: 'text.transform', version: '1',
      installedAt: '2026-09-22T20:22:25.465Z', visibility: 'draft', inviteAccountIds: [],
    },
    title: '文章', summary: 'article', advertisable: true, activity: 'active',
    metrics: {
      successRate: { state: 'unknown', reason: 'no-local-sample' },
      p95LatencyMs: { state: 'unknown', reason: 'no-local-sample' },
      vramBytes: { state: 'unknown', reason: 'not-probed' },
    },
    freeDiskBytes: 8 * GIB, totalMemoryBytes: 16 * GIB,
    ...overrides,
  }
}

const failed: PreflightReportView = {
  listingId: 'qianshou.article',
  steps: [
    { id: 'signature', state: 'passed', reason: '', detail: '' },
    { id: 'dependencies', state: 'failed', reason: 'DEPENDENCY_MISSING', detail: 'name=qianshou-extra' },
    { id: 'model', state: 'not-checked', reason: 'PENDING_EARLIER_STEP', detail: '' },
    { id: 'resources', state: 'not-checked', reason: 'PENDING_EARLIER_STEP', detail: '' },
  ],
  verdict: 'failed',
  failedStep: 'dependencies',
  actions: ['fix', 'recheck', 'cancel', 'rollback'],
}

function view(overrides: Partial<CapabilitiesView> = {}): CapabilitiesView {
  return {
    loaded: true,
    capabilities: [capability()],
    wizardSteps: ['identity', 'run-preflight', 'order-policy', 'publish'],
    order: { mode: 'idle', maxConcurrency: 2 },
    loading: false,
    busy: null,
    error: null,
    notice: null,
    selectedId: null,
    step: null,
    visibility: 'draft',
    confirmed: false,
    inviteText: '',
    report: null,
    ...overrides,
  }
}

const actions = () => ({
  ensure: vi.fn(), reload: vi.fn(), open: vi.fn(), close: vi.fn(), selectStep: vi.fn(), selectVisibility: vi.fn(),
  confirmPublic: vi.fn(), editInvite: vi.fn(), runPreflight: vi.fn(), saveDraft: vi.fn(), publish: vi.fn(),
  openIntakeSettings: vi.fn(), tryPrivateLocal: vi.fn(async () => true), managePrivateLocal: vi.fn(),
})

/** The one card's section, so a wizard under it is not confused with the page. */
const card = () => document.querySelector('[data-capability-card]') as HTMLElement

describe('我的能力 panel', () => {
  it('keeps platform declarations separate from local skills and plugins', () => {
    render(<CapabilitiesPanel view={view({ capabilities: [] })} t={t} marketT={marketT} {...actions()} />)
    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(document.querySelector('[data-private-local-capability]')).toBeNull()
  })

  it('shows saved owner state as a compact read-only bar and returns to the one intake switch', () => {
    const props = actions()
    render(<CapabilitiesPanel view={view({ order: { mode: 'off', maxConcurrency: 2, enabledServiceCount: 0 } })}
      t={t} marketT={marketT} {...props} />)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.getByText(en.orderOff)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.openIntakeSettings }))
    expect(props.openIntakeSettings).toHaveBeenCalledOnce()
    expect(within(card()).getByText(en.supplyServiceUnknown)).toBeTruthy()
    cleanup()
    render(<CapabilitiesPanel view={view({ order: { mode: 'idle', maxConcurrency: 2, enabledServiceCount: 0 } })}
      t={t} marketT={marketT} {...props} />)
    expect(screen.getByText(en.supplyNoServices)).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
    cleanup()
    render(<CapabilitiesPanel view={view({ order: null })} t={t} marketT={marketT} {...actions()} />)
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('shows an uninstalled package as a retained declaration without enabling publication', () => {
    render(<CapabilitiesPanel view={view({
      capabilities: [capability({ activity: 'inactive', advertisable: false })],
      selectedId: 'qianshou.article', step: 'publish',
    })} t={t} marketT={marketT} {...actions()} />)
    expect(within(card()).getAllByText(en.notAdvertisable).length).toBeGreaterThan(0)
    expect(within(card()).getByRole('button', { name: en.publish })).toHaveProperty('disabled', true)
  })

  it('shows each declaration with its facts, its visibility and its measured numbers', () => {
    render(<CapabilitiesPanel view={view({
      capabilities: [capability({
        record: {
          id: 'qianshou.article', capabilityId: 'text.transform', version: '1', installedAt: '2026-09-22T20:22:25.465Z',
          visibility: 'invite', inviteAccountIds: ['12', '34'],
        },
        metrics: {
          successRate: { state: 'measured', value: 0.98 },
          p95LatencyMs: { state: 'measured', value: 1_234 },
          vramBytes: { state: 'measured', value: 24 * GIB },
        },
      })],
    })} t={t} marketT={marketT} {...actions()} />)
    const section = card()
    expect(section.getAttribute('data-capability-card')).toBe('qianshou.article')
    expect(section.getAttribute('data-capability-advertisable')).toBe('true')
    expect(within(section).getByRole('heading', { level: 3, name: marketEn.articleTitle })).toBeTruthy()
    expect(within(section).getByText('text.transform')).toBeTruthy()
    expect(within(section).getByText('2026-09-22T20:22:25.465Z')).toBeTruthy()
    // The current visibility reads in the owner's language, and the invite list is a count.
    expect(section.querySelector('[data-capability-record-visibility]')?.textContent).toBe(en.visibilityInvite)
    expect(section.querySelector('[data-capability-record-visibility]')?.getAttribute('data-capability-record-visibility')).toBe('invite')
    expect(within(section).getByText('2')).toBeTruthy()
    // A measured number shows the number and its unit, in GiB.
    expect(section.querySelector('[data-metric="success-rate"]')?.textContent).toBe('98%')
    expect(section.querySelector('[data-metric="p95-latency"]')?.textContent).toBe('1234 ms')
    expect(section.querySelector('[data-metric="vram"]')?.textContent).toBe('24.0 GiB')
    expect(within(section).getByText(en.metricGib.replace('{value}', '8.0'))).toBeTruthy()
    expect(within(section).getByText(en.metricGib.replace('{value}', '16.0'))).toBeTruthy()
  })

  it('shows an unmeasured number as unknown with its reason, never as zero', () => {
    render(<CapabilitiesPanel view={view()} t={t} marketT={marketT} {...actions()} />)
    const section = card()
    expect(section.querySelector('[data-metric="success-rate"]')?.textContent)
      .toBe(`${en.metricUnknown} ${en.metricUnknownNoLocalSample}`)
    expect(section.querySelector('[data-metric="vram"]')?.textContent)
      .toBe(`${en.metricUnknown} ${en.metricUnknownNotProbed}`)
    for (const metric of ['success-rate', 'p95-latency', 'vram']) {
      expect(section.querySelector(`[data-metric="${metric}"]`)?.textContent).not.toContain('0')
    }
  })

  it('says a capability this computer cannot accept is refused rather than merely unavailable', () => {
    const props = actions()
    render(<CapabilitiesPanel view={view({ capabilities: [capability({ advertisable: false })] })}
      t={t} marketT={marketT} {...props} />)
    const section = card()
    expect(section.getAttribute('data-capability-advertisable')).toBe('false')
    expect(within(section).getByText(en.notAdvertisable)).toBeTruthy()
    fireEvent.click(within(section).getByRole('button', { name: en.wizardOpen }))
    expect(props.open).toHaveBeenCalledExactlyOnceWith('qianshou.article')
    cleanup()
    render(<CapabilitiesPanel view={view({
      capabilities: [capability({ advertisable: false })], selectedId: 'qianshou.article', step: 'publish',
    })} t={t} marketT={marketT} {...actions()} />)
    expect(within(card()).getByText(en.publishRefused)).toBeTruthy()
    expect(within(card()).getByRole('button', { name: en.publish })).toHaveProperty('disabled', true)
  })

  it('renders the four steps in the order the host named, opening on the current one', () => {
    const props = actions()
    render(<CapabilitiesPanel view={view({ selectedId: 'qianshou.article', step: 'order-policy' })}
      t={t} marketT={marketT} {...props} />)
    const steps = [...document.querySelectorAll('[data-capability-step]')]
    expect(steps.map(step => step.getAttribute('data-capability-step')))
      .toEqual(['identity', 'run-preflight', 'order-policy', 'publish'])
    expect(steps.map(step => step.getAttribute('data-step-state'))).toEqual(['other', 'other', 'current', 'other'])
    expect(screen.getByRole('button', { name: `3. ${en.stepOrderPolicy}` }).getAttribute('aria-current')).toBe('step')
    fireEvent.click(screen.getByRole('button', { name: `4. ${en.stepPublish}` }))
    expect(props.selectStep).toHaveBeenCalledExactlyOnceWith('publish')
    // The step controls walk the host's order and stop at its ends.
    fireEvent.click(screen.getByRole('button', { name: en.stepNext }))
    expect(props.selectStep).toHaveBeenLastCalledWith('publish')
    expect(screen.getByRole('button', { name: en.stepBack })).toHaveProperty('disabled', false)
  })

  it('offers only a draft save on the first three steps and the visibility choice only on the last', () => {
    for (const step of ['identity', 'run-preflight', 'order-policy'] as const) {
      cleanup()
      const props = actions()
      render(<CapabilitiesPanel view={view({ selectedId: 'qianshou.article', step })} t={t} marketT={marketT} {...props} />)
      const inside = card()
      expect(within(inside).getByRole('button', { name: en.saveDraft })).toHaveProperty('disabled', false)
      expect(within(inside).queryByRole('button', { name: en.publish })).toBeNull()
      expect(within(inside).queryByRole('radio')).toBeNull()
      fireEvent.click(within(inside).getByRole('button', { name: en.saveDraft }))
      expect(props.saveDraft).toHaveBeenCalledExactlyOnceWith('qianshou.article')
      expect(props.publish).not.toHaveBeenCalled()
    }
    cleanup()
    const props = actions()
    render(<CapabilitiesPanel view={view({ selectedId: 'qianshou.article', step: 'publish' })} t={t} marketT={marketT} {...props} />)
    const inside = card()
    expect(within(inside).queryByRole('button', { name: en.saveDraft })).toBeNull()
    const radios = within(inside).getAllByRole('radio')
    expect(radios.map(radio => radio.getAttribute('data-capability-visibility')))
      .toEqual(['draft', 'private', 'invite', 'public'])
    expect(radios.map(radio => (radio as HTMLInputElement).checked)).toEqual([true, false, false, false])
    expect(within(inside).queryByRole('checkbox', { name: en.confirmPublicLabel })).toBeNull()
    fireEvent.click(radios[3] as HTMLElement)
    expect(props.selectVisibility).toHaveBeenCalledExactlyOnceWith('public')
    // The confirmation is asked for by the public choice alone: a draft publishes without it.
    fireEvent.click(within(inside).getByRole('button', { name: en.publish }))
    expect(props.publish).toHaveBeenCalledExactlyOnceWith('qianshou.article')
    cleanup()
    render(<CapabilitiesPanel view={view({ selectedId: 'qianshou.article', step: 'publish', visibility: 'public' })}
      t={t} marketT={marketT} {...actions()} />)
    // Without the confirmation, public cannot be published, and the page says why.
    expect(within(card()).getByRole('button', { name: en.publish })).toHaveProperty('disabled', true)
    expect(within(card()).getByText(en.publishNeedsConfirm)).toBeTruthy()
  })

  it('publishes once the owner confirmed the public choice', () => {
    const props = actions()
    render(<CapabilitiesPanel view={view({ selectedId: 'qianshou.article', step: 'publish', visibility: 'public', confirmed: true })}
      t={t} marketT={marketT} {...props} />)
    const publish = within(card()).getByRole('button', { name: en.publish })
    expect(publish).toHaveProperty('disabled', false)
    fireEvent.click(publish)
    expect(props.publish).toHaveBeenCalledExactlyOnceWith('qianshou.article')
    fireEvent.click(within(card()).getByRole('checkbox', { name: en.confirmPublicLabel }))
    expect(props.confirmPublic).toHaveBeenCalledExactlyOnceWith(false)
    expect(within(card()).getByText(en.visibilityPublicNote)).toBeTruthy()
  })

  it('enables the invited-account field only for the invited-accounts visibility, and says the list stays here', () => {
    const props = actions()
    render(<CapabilitiesPanel view={view({
      selectedId: 'qianshou.article', step: 'order-policy', visibility: 'invite', inviteText: '12\n34',
    })} t={t} marketT={marketT} {...props} />)
    const field = within(card()).getByRole('textbox', { name: en.inviteLabel })
    expect(field).toHaveProperty('disabled', false)
    expect((field as HTMLTextAreaElement).value).toBe('12\n34')
    expect(within(card()).getByText(en.inviteNote)).toBeTruthy()
    fireEvent.change(field, { target: { value: '12\n56' } })
    expect(props.editInvite).toHaveBeenCalledExactlyOnceWith('12\n56')
    cleanup()
    render(<CapabilitiesPanel view={view({ selectedId: 'qianshou.article', step: 'order-policy', visibility: 'draft' })}
      t={t} marketT={marketT} {...actions()} />)
    expect(within(card()).getByRole('textbox', { name: en.inviteLabel })).toHaveProperty('disabled', true)
    expect(within(card()).getByText(en.inviteLocked)).toBeTruthy()
  })

  it('shows the order policy this computer loaded, and says unknown when no compute service runs here', () => {
    render(<CapabilitiesPanel view={view({ selectedId: 'qianshou.article', step: 'order-policy' })}
      t={t} marketT={marketT} {...actions()} />)
    expect(within(card()).getByText(en.orderIdle)).toBeTruthy()
    expect(within(card()).getByText('2')).toBeTruthy()
    cleanup()
    render(<CapabilitiesPanel view={view({ selectedId: 'qianshou.article', step: 'order-policy', order: null })}
      t={t} marketT={marketT} {...actions()} />)
    expect(within(card()).getByText(en.orderUnknown)).toBeTruthy()
  })

  it('runs the checks from their step and renders the report the market page renders', () => {
    const props = actions()
    render(<CapabilitiesPanel view={view({ selectedId: 'qianshou.article', step: 'run-preflight' })}
      t={t} marketT={marketT} {...props} />)
    expect(within(card()).getByText(en.preflightNone)).toBeTruthy()
    fireEvent.click(within(card()).getByRole('button', { name: en.preflightRun }))
    expect(props.runPreflight).toHaveBeenCalledExactlyOnceWith('qianshou.article')
    cleanup()
    render(<CapabilitiesPanel view={view({ selectedId: 'qianshou.article', step: 'run-preflight', report: failed })}
      t={t} marketT={marketT} {...actions()} />)
    const checks = [...card().querySelectorAll('[data-check-state]')]
    expect(checks.map(check => check.textContent)).toEqual([
      `${marketEn.stepSignature}${marketEn.stepPassed}`,
      `${marketEn.stepDependencies}${marketEn.stepFailed}${marketEn.reasonDependencyMissing}name=qianshou-extra`,
      `${marketEn.stepModel}${marketEn.stepNotChecked}${marketEn.reasonPendingEarlierStep}`,
      `${marketEn.stepResources}${marketEn.stepNotChecked}${marketEn.reasonPendingEarlierStep}`,
    ])
  })

  it('opens and closes the wizard from the card, and reports a running check', () => {
    const props = actions()
    render(<CapabilitiesPanel view={view()} t={t} marketT={marketT} {...props} />)
    expect(card().querySelector('[data-capability-wizard]')).toBeNull()
    fireEvent.click(within(card()).getByRole('button', { name: en.wizardOpen }))
    expect(props.open).toHaveBeenCalledExactlyOnceWith('qianshou.article')
    cleanup()
    const running = actions()
    render(<CapabilitiesPanel view={view({ selectedId: 'qianshou.article', step: 'run-preflight', busy: 'preflight' })}
      t={t} marketT={marketT} {...running} />)
    expect(within(card()).getByRole('button', { name: en.preflightRunning })).toHaveProperty('disabled', true)
    expect(within(card()).getByRole('button', { name: en.saveDraft })).toHaveProperty('disabled', true)
    cleanup()
    const open = actions()
    render(<CapabilitiesPanel view={view({ selectedId: 'qianshou.article', step: 'publish' })} t={t} marketT={marketT} {...open} />)
    fireEvent.click(within(card()).getByRole('button', { name: en.wizardClose }))
    expect(open.close).toHaveBeenCalledOnce()
  })

  it('keeps the rows it read while a reload runs, and guides an empty declaration list', () => {
    render(<CapabilitiesPanel view={view({ loading: true })} t={t} marketT={marketT} {...actions()} />)
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    expect(document.querySelectorAll('[data-capability-card]')).toHaveLength(1)
    cleanup()
    render(<CapabilitiesPanel view={view({ capabilities: [], loading: false })} t={t} marketT={marketT} {...actions()} />)
    expect(screen.getByText(en.empty)).toBeTruthy()
    cleanup()
    // A first read that has not finished does not claim the declaration list is empty.
    render(<CapabilitiesPanel view={view({ capabilities: [], loaded: false })} t={t} marketT={marketT} {...actions()} />)
    expect(screen.queryByText(en.empty)).toBeNull()
  })

  it('counts platform registrations separately from an installed skill and an enabled local plugin', () => {
    const skill: LocalSkillEntry = {
      name: 'text-helper', displayName: '文字助手', description: '整理文字', category: 'text',
      source: 'user-agents', path: '/skills/text-helper/SKILL.md', updatedAt: 1,
      modelInvocable: true, userInvocable: true,
    }
    const candidate: LocalPluginCandidateView = {
      draftId: 'plugin_draft_12345678-1234-1234-1234-123456789abc',
      packageName: 'qianshou-local-text-helper', packagePath: '/plugins/text-helper',
      toolName: 'qianshou_local_text_helper', sourceDigest: 'a'.repeat(64), packageDigest: 'b'.repeat(64),
      displayName: '文字反转', description: '反转输入文字', operationTitle: '反转文字', preparedAt: 1,
      installableLocally: true, published: false, dispatchable: false,
    }
    render(<CapabilitiesPanel view={view({ capabilities: [] })} t={translate(zh)} marketT={marketT} {...actions()}
      localSkills={{ view: { status: 'ready', skills: [skill] }, t: key => localSkillZh[key],
        ensure: vi.fn(async () => {}), reload: vi.fn(async () => {}), compact: true }}
      localPluginCandidates={{ view: { status: 'ready', candidates: [candidate] },
        installed: [{ name: candidate.packageName, enabled: true, installed: true }],
        t: key => localCandidateZh[key], reload: vi.fn(async () => {}), reviewInstall: vi.fn() }} />)
    expect(screen.getByRole('heading', { name: '文字助手' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '文字反转' })).toBeTruthy()
    expect(document.querySelector('[data-local-plugin-state="enabled"]')).toBeTruthy()
    expect(screen.getByText(zh.count.replace('{count}', '0'))).toBeTruthy()
    expect(screen.getByText(zh.empty)).toBeTruthy()
    expect(screen.queryByText('本机还没有已安装的能力。')).toBeNull()
  })

  it('offers a retry when the read failed and words the words the host returned as a key', () => {
    const props = actions()
    render(<CapabilitiesPanel view={view({ error: 'errorNotAdvertisable' })} t={t} marketT={marketT} {...props} />)
    expect(screen.getByRole('alert').textContent).toContain(en.errorNotAdvertisable)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(props.reload).toHaveBeenCalledOnce()
  })

  it('words a finished write once, and speaks both languages', () => {
    render(<CapabilitiesPanel view={view({ notice: { kind: 'published', visibility: 'public' } })}
      t={t} marketT={marketT} {...actions()} />)
    expect(screen.getByRole('status').textContent).toBe(en.publishDone.replace('{visibility}', en.visibilityPublic))
    cleanup()
    render(<CapabilitiesPanel view={view({
      selectedId: 'qianshou.article', step: 'publish', visibility: 'invite',
    })} t={translate(zh)} marketT={marketT} {...actions()} />)
    expect(within(card()).getByRole('button', { name: zh.publish })).toBeTruthy()
    expect(within(card()).queryByRole('checkbox', { name: zh.confirmPublicLabel })).toBeNull()
    expect(within(card()).getByText(zh.visibilityInviteNote)).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(zh.title)
  })
})
