import { describe, expect, it } from 'vitest'
import { advanceCharacterPosition, avoidCharacterPanel, characterBounds, fitCharacterPosition } from '../src/client/chat/voice/character-position.ts'

describe('window character coordinates', () => {
  const bounds = characterBounds({ width: 880, height: 600 }, { width: 220, height: 330 })

  it('keeps the whole stage inside the viewport and clamps a viewport shrink', () => {
    expect(bounds).toEqual({ left: 12, right: 648, top: 12, bottom: 258 })
    expect(fitCharacterPosition({ x: 2000, y: -40 }, bounds)).toEqual({ x: 648, y: 12 })
    const narrow = characterBounds({ width: 240, height: 340 }, { width: 220, height: 330 })
    expect(narrow).toEqual({ left: 10, right: 10, top: 5, bottom: 5 })
    expect(fitCharacterPosition({ x: 648, y: 258 }, narrow)).toEqual({ x: 10, y: 5 })
    expect(characterBounds({ width: 100, height: 100 }, { width: 220, height: 330 }))
      .toEqual({ left: 0, right: 0, top: 0, bottom: 0 })
  })

  it('walks horizontally and reverses at either edge without crossing it', () => {
    expect(advanceCharacterPosition({ x: 647, y: 258 }, 'walk', 1, 1, bounds))
      .toEqual({ position: { x: 648, y: 258 }, direction: -1, moving: true })
    expect(advanceCharacterPosition({ x: 13, y: 258 }, 'walk', -1, 1, bounds))
      .toEqual({ position: { x: 12, y: 258 }, direction: 1, moving: true })
  })

  it('climbs vertically and limits travel after a suspended frame', () => {
    const climbing = advanceCharacterPosition({ x: 12, y: 200 }, 'climb', -1, 30, bounds)
    expect(climbing.position.x).toBe(12)
    expect(climbing.position.y).toBeCloseTo(198.464)
    expect(advanceCharacterPosition({ x: 12, y: 12 }, 'climb', -1, .03, bounds).direction).toBe(1)
  })

  it.each(['idle', 'wave', 'lean', 'sit'] as const)('does not move for the %s pose', (action) => {
    expect(advanceCharacterPosition({ x: 50, y: 80 }, action, 1, 1, bounds))
      .toEqual({ position: { x: 50, y: 80 }, direction: 1, moving: false })
  })

  it('stops when there is no travel room or no elapsed time', () => {
    expect(advanceCharacterPosition({ x: 12, y: 12 }, 'walk', 1, .03, { left: 12, right: 12, top: 12, bottom: 100 }).moving)
      .toBe(false)
    expect(advanceCharacterPosition({ x: 50, y: 80 }, 'walk', 1, -1, bounds).moving).toBe(false)
  })
  it('docks to the opposite side of an expanded team panel on desktop', () => {
    expect(avoidCharacterPanel({ x: 648, y: 258 }, { width: 220, height: 330 }, bounds,
      { left: 568, right: 864, top: 76, bottom: 500 }))
      .toEqual({ position: { x: 12, y: 258 }, detailsMaxHeight: 240 })
    expect(avoidCharacterPanel({ x: 12, y: 258 }, { width: 220, height: 330 }, bounds,
      { left: 12, right: 308, top: 76, bottom: 500 }).position.x).toBe(648)
  })

  it('fits narrow-screen voice controls below the measured panel and keeps close reachable', () => {
    const narrow = characterBounds({ width: 360, height: 640 }, { width: 220, height: 330 })
    const result = avoidCharacterPanel({ x: 128, y: 12 }, { width: 220, height: 330 }, narrow,
      { left: 56, right: 352, top: 64, bottom: 449 })
    expect(result).toEqual({ position: { x: 128, y: 298 }, detailsMaxHeight: 125 })
    expect(result.position.y + 330 - 42 - result.detailsMaxHeight).toBeGreaterThan(449)
    expect(avoidCharacterPanel({ x: 128, y: 298 }, { width: 220, height: 330 }, narrow, undefined))
      .toEqual({ position: { x: 128, y: 298 }, detailsMaxHeight: 240 })
  })

})
