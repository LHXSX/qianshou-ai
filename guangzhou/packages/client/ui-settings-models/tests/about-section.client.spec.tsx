// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AboutSection } from '../src/client/AboutSection.tsx'
import { forgeEn, forgeZh } from '../src/client/locales.ts'

const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
const unused = (() => { throw new Error('unused') }) as never

afterEach(cleanup)

describe('AboutSection', () => {
  it('keeps the open-source line on the About page, not the product home', () => {
    render(<AboutSection
      t={key => forgeZh[key]}
      // The shell owns settings visibility; this section only renders, so it
      // must never call `close`. The throwing sentinel makes an accidental call
      // fail loudly instead of silently closing nothing.
      close={unused}
      useSessions={unused}
      useSessionPendingInteraction={unused}
      usePanelInfo={usePanelInfo}
      useResource={useResource}
      useWorkspaces={unused}
    />)
    expect(screen.getByRole('heading', { name: forgeZh.aboutTitle })).toBeTruthy()
    expect(screen.getByText(forgeZh.aboutAttribution, { exact: false })).toBeTruthy()
    const source = screen.getByRole('link', { name: forgeZh.welcomeSource })
    expect(source.getAttribute('href')).toBe('https://github.com/deepseek-ai/deepseek-harness')
    expect(forgeZh.welcomeBody).not.toContain('DeepSeek Harness')
    expect(forgeEn.welcomeBody).not.toContain('DeepSeek Harness')
  })
})
