import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/ForgeBrand.module.css', import.meta.url)), 'utf8')

describe('Qianshou identity styles', () => {
  it('uses the theme accent and its contrast ink with unclipped title geometry', () => {
    expect(css).toMatch(/\.mark\s*\{[^}]*color:\s*var\(--dsw-alias-brand-primary\)/)
    expect(css).toMatch(/\.ink\s*\{[^}]*color:\s*var\(--dsw-alias-label-primary-foreground\)/)
    expect(css).toMatch(/\.mark\s*\{[^}]*display:\s*block/)
    const title = css.match(/\.name strong\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(title).toMatch(/line-height:\s*22px/)
    expect(title).toMatch(/white-space:\s*nowrap/)
    expect(title).not.toMatch(/overflow:\s*hidden/)
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|(?:rgb|hsl)a?\(/i)
  })
})
