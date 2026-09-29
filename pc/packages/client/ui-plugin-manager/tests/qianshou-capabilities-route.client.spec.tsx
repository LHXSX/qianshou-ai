// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QianshouCapabilitiesPage } from '../src/client/QianshouManagerPage.tsx'
import { en as capabilityEn } from '../src/client/capability-locales.ts'
import { en as marketEn } from '../src/client/marketplace-locales.ts'
import { en as localSkillsEn } from '../src/client/local-skill-locales.ts'
import { en as localCandidatesEn } from '../src/client/local-plugin-candidate-locales.ts'

afterEach(cleanup)

describe('direct owner intake settings route', () => {
  it('refreshes the saved policy and links back to the sole intake switch', () => {
    const reload = vi.fn()
    const openIntakeSettings = vi.fn()
    const state = {
      loaded: true, capabilities: [], wizardSteps: [], order: { mode: 'off', enabledServiceCount: 0 },
      loading: false, busy: null, error: null, notice: null, selectedId: null, step: null,
      visibility: 'draft', confirmed: false, inviteText: '', report: null,
    }
    const props = {
      useCapabilities: (select: (value: typeof state) => unknown) => select(state),
      useLocalSkills: (select: (value: { status: string; skills: never[] }) => unknown) => select({ status: 'ready', skills: [] }),
      useSessionSkills: (select: (value: { status: string; sessionId: null; skills: never[] }) => unknown) => select({ status: 'ready', sessionId: null, skills: [] }),
      useLocalPluginCandidates: (select: (value: { status: string; candidates: never[] }) => unknown) => select({ status: 'ready', candidates: [] }),
      useOrderPublication: (select: (value: { busyKey: null; items: Record<string, never> }) => unknown) => select({ busyKey: null, items: {} }),
      usePluginManager: (select: (value: { packages: never[] }) => unknown) => select({ packages: [] }),
      localSkillsTranslate: (key: keyof typeof localSkillsEn) => localSkillsEn[key],
      localPluginCandidatesTranslate: (key: keyof typeof localCandidatesEn) => localCandidatesEn[key],
      localSkillsEnsure: vi.fn(async () => {}), localSkillsReload: vi.fn(async () => {}),
      localPluginCandidatesReload: vi.fn(async () => {}), localPluginCandidatesCheckInstalled: vi.fn(async () => {}),
      useSessionSkill: vi.fn(), reviewLocalCandidate: vi.fn(), ensure: vi.fn(),
      publishOrderSkill: vi.fn(async () => {}), publishOrderCandidate: vi.fn(async () => {}),
      capabilitiesTranslate: (key: keyof typeof capabilityEn) => capabilityEn[key],
      marketTranslate: (key: keyof typeof marketEn) => marketEn[key],
      capabilitiesEnsure: vi.fn(),
      capabilitiesReload: reload, openIntakeSettings,
      capabilitiesOpen: vi.fn(), capabilitiesClose: vi.fn(), capabilitiesSelectStep: vi.fn(),
      capabilitiesSelectVisibility: vi.fn(), capabilitiesConfirmPublic: vi.fn(), capabilitiesEditInvite: vi.fn(),
      capabilitiesRunPreflight: vi.fn(), capabilitiesSaveDraft: vi.fn(), capabilitiesPublish: vi.fn(),
    } as unknown as Parameters<typeof QianshouCapabilitiesPage>[0]
    const view = render(<QianshouCapabilitiesPage {...props} />)
    expect(reload).toHaveBeenCalledOnce()
    expect(view.container.querySelector('[data-qianshou-capabilities-route]')).not.toBeNull()
    expect(view.getByRole('heading', { name: capabilityEn.supplyTitle })).toBeTruthy()
    expect(view.queryByRole('switch')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: capabilityEn.openIntakeSettings }))
    expect(openIntakeSettings).toHaveBeenCalledOnce()
  })
})
