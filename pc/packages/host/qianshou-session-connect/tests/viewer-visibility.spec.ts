// @vitest-environment jsdom
/** Real stylesheet cascade regression: a layout rule must not reveal a hidden authorization control. */
import { afterEach, expect, it } from 'vitest'
import { pageCss } from '../src/page.ts'

afterEach(() => { document.head.replaceChildren(); document.body.replaceChildren() })

it('keeps a hidden send form and hidden actions outside the rendered layout', () => {
  const style = document.createElement('style'); style.textContent = pageCss; document.head.append(style)
  const form = document.createElement('form'), action = document.createElement('button')
  form.append(action); document.body.append(form)
  expect(getComputedStyle(form).display).toBe('grid')
  form.hidden = true; action.hidden = true
  expect(getComputedStyle(form).display).toBe('none')
  expect(getComputedStyle(action).display).toBe('none')
  form.hidden = false
  expect(getComputedStyle(form).display).toBe('grid')
  expect(getComputedStyle(action).display).toBe('none')
})
