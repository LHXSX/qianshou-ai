// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { RunningQianshouCat } from '../src/client/chat/RunningQianshouCat.tsx'

afterEach(() => { cleanup() })

it.each(['ceo', 'helper', 'call'] as const)('renders the supplied mode %s as a decorative sprite', (mode) => {
  const view = render(<RunningQianshouCat mode={mode} />)
  const mascot = view.container.querySelector('[data-qianshou-running-cat]')
  expect(mascot?.getAttribute('data-qianshou-mascot-mode')).toBe(mode)
  expect(mascot?.getAttribute('aria-hidden')).toBe('true')
  expect(mascot?.querySelector('[data-qianshou-cat-sprite]')).not.toBeNull()
})

it('keeps the default CEO mascot and changes only with the supplied mode', () => {
  const view = render(<RunningQianshouCat />)
  expect(view.container.querySelector('[data-qianshou-running-cat]')?.getAttribute('data-qianshou-mascot-mode')).toBe('ceo')
  view.rerender(<RunningQianshouCat mode="call" />)
  expect(view.container.querySelector('[data-qianshou-running-cat]')?.getAttribute('data-qianshou-mascot-mode')).toBe('call')
})

it('steps through all eight atlas cells and stops on frame one for reduced motion', () => {
  const css = readFileSync(resolve('packages/client/ui-chat/src/client/chat/RunningQianshouCat.module.css'), 'utf8')
  expect(css).toContain('background-size: 400% 200%')
  expect(css).toContain('steps(1, end) infinite')
  const positions = [...css.matchAll(/background-position: ([\d.%]+) ([\d.%]+);/gu)].map(match => [match[1], match[2]])
  expect(new Set(positions.map(pair => pair.join(' '))).size).toBe(8)
  expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none;[\s\S]*background-position: 0% 0%;/u)
  expect(css).not.toMatch(/opacity|filter|brightness/iu)
})
