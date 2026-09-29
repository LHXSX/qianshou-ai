import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/chat/voice/CharacterStage.module.css', import.meta.url)), 'utf8')

describe('character click-through geometry', () => {
  it('lets clicks pass through the complete art area and confines input to controls', () => {
    expect(css).toMatch(/\.stage\s*\{[^}]*pointer-events:\s*none/)
    expect(css).toMatch(/\.art, \.art \*\s*\{\s*pointer-events:\s*none/)
    expect(css).toMatch(/\.toolbar\s*\{[^}]*pointer-events:\s*auto/)
    expect(css).toMatch(/\.details\s*\{[^}]*pointer-events:\s*auto/)
    expect(css).toMatch(/\.details\[hidden\]\s*\{\s*display:\s*none/)
    expect(css).toContain('width: min(220px, calc(100vw - 24px))')
    expect(css).toContain('height: min(330px, calc(100dvh - 24px))')
  })
})
