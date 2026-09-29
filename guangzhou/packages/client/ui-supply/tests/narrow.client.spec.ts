/**
 * Narrow-screen safety as CSS text. jsdom has no layout engine, so this spec
 * pins the declarations that keep a 320px-wide viewport from scrolling
 * sideways; `tests/browser/verify.mjs` measures the real rendered page.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (): string => readFileSync(fileURLToPath(new URL('../src/client/SupplyPage.module.css', import.meta.url)), 'utf8')

function declarations(source: string, selector: string): string[] {
  const declarationText = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rule = new RegExp(`(?:^|[{}])\\s*${selector.replace(/[.[\]():*+^$\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(declarationText)
  if (rule === null) throw new Error(`no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('supply page narrow-screen CSS', () => {
  it('lays the cards out in one fluid track instead of fixed-width columns', () => {
    expect(declarations(read(), '.columns')).toEqual(expect.arrayContaining([
      'grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr))',
    ]))
    expect(declarations(read(), '.card')).toEqual(expect.arrayContaining(['min-width: 0']))
  })

  it('never declares a fixed pixel width anywhere in the stylesheet', () => {
    expect([...read().matchAll(/(?:^|[;{]\s*)width:\s*(\d+(?:\.\d+)?)px/gu)].map(match => match[1])).toEqual([])
  })

  it('wraps long identifiers, codes and hints instead of overflowing', () => {
    for (const selector of ['.hint', '.facts dd', '.inlineFacts dd', '.reasons li span', '.tight li', '.stale', '.boundary', '.service strong']) {
      expect(declarations(read(), selector)).toEqual(expect.arrayContaining(['overflow-wrap: anywhere']))
    }
    expect(declarations(read(), '.form select')).toEqual(expect.arrayContaining(['max-width: 100%', 'min-width: 0']))
  })

  it('tightens the padding and stacks the header on a phone viewport', () => {
    const css = read()
    const media = /@media \(max-width: 560px\) \{([\s\S]*)\}\s*$/u.exec(css)
    expect(media).not.toBeNull()
    const phone = media?.[1] ?? ''
    expect(declarations(phone, '.page')).toEqual(['padding: 16px'])
    expect(declarations(phone, '.header')).toEqual(expect.arrayContaining(['flex-direction: column']))
    expect(phone).toContain('.observation, .card { padding: 16px; }')
  })
})
