import { describe, expect, it } from 'vitest'
import { resolveDesktopWebPort } from '../src/web-port.ts'

describe('desktop web port', () => {
  it('keeps the installed default and accepts an isolated loopback port', () => {
    expect(resolveDesktopWebPort(undefined)).toBe(19_387)
    expect(resolveDesktopWebPort('')).toBe(19_387)
    expect(resolveDesktopWebPort('19487')).toBe(19_487)
  })

  it.each(['0', '65536', '-1', '1.5', ' 19487', '19487 ', '0x4c1f', 'NaN'])('rejects an invalid non-default port %s', (value) => {
    expect(() => resolveDesktopWebPort(value)).toThrow('DSH_DESKTOP_WEB_PORT')
  })
})
