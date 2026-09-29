import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/** Keep the mobile visual contract explicit while the DOM remains framework-free. */
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

it('keeps the enterprise dopamine tokens and compact composer contract', () => {
  for (const token of ['--qs-violet', '--qs-pink', '--qs-mint', '--qs-coral', '--qs-yellow', '--qs-gradient-brand']) {
    expect(css).toContain(token)
  }
  expect(css).toMatch(/\.composer\s*\{[\s\S]*?flex-wrap:\s*nowrap/)
  expect(css).toMatch(/\.mobile-shell\s*\{[\s\S]*?top:\s*var\(--qs-viewport-offset-top,\s*0px\)/)
  expect(css).toMatch(/\.composer textarea\s*\{[\s\S]*?max-height:\s*116px/)
  expect(css).toContain('[data-testid="mobile-activity"]')
  expect(css).toContain('[data-testid^="mobile-activity-"]')
})

it('draws the plus as a hairline ring/cross and voice as a compact speaker wave, never a note', () => {
  const concept = readFileSync(new URL('../src/concept-skin.css', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const messages = readFileSync(new URL('../src/components/message-view.ts', import.meta.url), 'utf8')
  expect(css).toContain('.composer-add svg')
  expect(concept).toContain('.composer-add svg')
  expect(concept).toContain('.composer .voice-button[data-testid="mobile-voice"] svg')
  expect(main).toContain("composerIcon('plus')")
  expect(main).toContain("composerIcon('mic')")
  expect(main).toContain('startComposerVoice')
  expect(main).not.toContain('voice-dialog')
  expect(main).not.toContain('voiceDialog.showModal')
  expect(main).not.toContain('composer.append(voiceStatus)')
  expect(css).toMatch(/\.composer\s*\{[\s\S]*?flex-wrap:\s*nowrap/)
  const copy = readFileSync(new URL('../src/components/account-copy.ts', import.meta.url), 'utf8')
  expect(copy).not.toContain('选择语音识别方式')
  expect(copy).not.toContain('同意并开始')
  expect(main).toContain("speaker.setAttribute('d', 'M4.8 10.1h3.1l4.15-3.25v10.3L7.9 13.9H4.8Z')")
  expect(messages).toContain('actionIcon(kind), caption')
  for (const source of [css, concept, main, messages]) {
    expect(source).not.toMatch(/[♩♪♫♬◉⧉]/)
  }
})

it('keeps a reduced-motion escape hatch for splash and shell interactions', () => {
  expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  expect(css).toContain('.splash-mark { animation: none; }')
})

it('keeps splash help out of the visible hit target', () => {
  expect(css).toMatch(/\.splash-help\s*\{[^}]*display:\s*none/)
  expect(css).not.toMatch(/\.splash-help[^{]*\{[^}]*top:\s*max\(/)
})

it('keeps generated images and copy inside the phone width', () => {
  const concept = readFileSync(new URL('../src/concept-skin.css', import.meta.url), 'utf8')
  expect(concept).toMatch(/\.generated-image\s*\{[^}]*max-width:\s*100%/)
  expect(concept).toMatch(/\.account-dialog-login[^{]*\{[^}]*height:\s*100dvh/)
  expect(concept).toMatch(/html\[data-skin="dopamine"\][^{]*\{[^}]*font-family:\s*inherit/)
  expect(css).toMatch(/\.message-body\s*\{[^}]*font-size:\s*17px/)
  expect(css).toMatch(/\.message-body\s*\{[^}]*white-space:\s*normal/)
  expect(css).toContain('.message-markdown')
  expect(css).toContain('.message-table')
  expect(css).toMatch(/\.generated-image-turn[\s\S]{0,120}align-self:\s*flex-start/)
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  expect(main).toContain('appendLocalConversation')
  expect(css).toContain('.pc-status-dot-online')
  expect(css).toMatch(/\.message-body pre[\s\S]*white-space:\s*pre-wrap/)
  expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.message-body \{ font-size: 17px; \}/)
  expect(css).not.toMatch(/@media \(max-width: 720px\)[\s\S]*\.message-body \{ font-size: 26px; \}/)
  expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.composer textarea \{ font-size: 17px; \}/)
  expect(main).toContain("stroke-width', kind === 'plus' ? '2.2'")
  expect(css).toMatch(/\.composer-add[^{]*\{[^}]*color:\s*var\(--qs-ink\)/)
  expect(css).toContain('.image-wait-card')
  expect(css).toContain('.image-wait-track')
  expect(css).toContain('.image-wait-bar')
  expect(css).toContain('.composer-attachments')
  expect(main).toContain('ignoreFollowScroll')
  expect(main).toContain('ResizeObserver')
  expect(main).toContain('stickToLatest')
  expect(css).toContain('.message-markdown hr')
  expect(css).toContain('.message-markdown code')
  expect(css).toContain('.image-lightbox')
  expect(css).toContain('.image-wait-percent')
  expect(main).toContain('restoreAlbum')
  expect(main).not.toMatch(/if \(mobile\.snapshot\(\)\.pending\) return/)
  expect(concept).toMatch(/\.message-user\s*\{[^}]*width:\s*fit-content/)
  expect(concept).toMatch(/\.message-user \.message-body,\s*\.message-user \.message-markdown\s*\{[^}]*background:\s*var\(--concept-primary\)/)
  expect(concept).not.toMatch(/User turns read as calm transcript text/)
  expect(concept).not.toMatch(/\.message-user \.message-body \{\s*background: transparent/)
})
