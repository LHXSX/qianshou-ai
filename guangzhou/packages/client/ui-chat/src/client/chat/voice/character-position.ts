/** Window-local coordinates and actions shared with the character renderer. */
export type CharacterAction = 'idle' | 'wave' | 'walk' | 'climb' | 'lean' | 'sit'
/** Horizontal orientation of the character, independent from pointer gaze. */
export type CharacterFacing = 'left' | 'right'
/** Presentation-only frame consumed by the character engine. */
export interface CharacterFrame {
  readonly action: CharacterAction
  readonly facing: CharacterFacing
  readonly moving: boolean
}
/** Top-left viewport position in CSS pixels. */
export interface CharacterPosition { readonly x: number; readonly y: number }
/** Available travel area for the complete character and its control strip. */
export interface CharacterBounds { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }
/** Dimensions in CSS pixels. */
export interface CharacterSize { readonly width: number; readonly height: number }
/** Direction along the currently selected movement axis. */
export type CharacterDirection = -1 | 1

/**
 * Reserve up to twelve pixels around a viewport-sized character area.
 * @param viewport - Current browser viewport dimensions.
 * @param size - Measured character area, including controls.
 * @returns Nonnegative bounds, also valid when the viewport has no spare space.
 */
export function characterBounds(viewport: CharacterSize, size: CharacterSize): CharacterBounds {
  const spareX = Math.max(0, viewport.width - size.width)
  const spareY = Math.max(0, viewport.height - size.height)
  const insetX = Math.min(12, spareX / 2)
  const insetY = Math.min(12, spareY / 2)
  return { left: insetX, right: spareX - insetX, top: insetY, bottom: spareY - insetY }
}

/**
 * Keep an entire character area within its current travel bounds.
 * @param position - Requested viewport position.
 * @param bounds - Current legal top-left coordinates.
 * @returns The nearest valid position.
 */
export function fitCharacterPosition(position: CharacterPosition, bounds: CharacterBounds): CharacterPosition {
  return {
    x: Math.max(bounds.left, Math.min(bounds.right, position.x)),
    y: Math.max(bounds.top, Math.min(bounds.bottom, position.y)),
  }
}

/**
 * Advance a user-selected walk or climb without jumping after a suspended tab.
 * @param position - Current top-left position.
 * @param action - Selected pose or movement.
 * @param direction - Current movement direction along its axis.
 * @param elapsedSeconds - Time since the preceding animation frame.
 * @param bounds - Current legal top-left coordinates.
 * @returns The bounded position and the direction for the next frame.
 */
export function advanceCharacterPosition(
  position: CharacterPosition, action: CharacterAction, direction: CharacterDirection,
  elapsedSeconds: number, bounds: CharacterBounds,
): { readonly position: CharacterPosition; readonly direction: CharacterDirection; readonly moving: boolean } {
  const current = fitCharacterPosition(position, bounds)
  if (action !== 'walk' && action !== 'climb') return { position: current, direction, moving: false }
  const axis = action === 'walk' ? 'x' : 'y'
  const low = axis === 'x' ? bounds.left : bounds.top
  const high = axis === 'x' ? bounds.right : bounds.bottom
  if (high <= low) return { position: current, direction, moving: false }
  const speed = action === 'walk' ? 36 : 24
  const delta = Math.max(0, Math.min(0.064, elapsedSeconds)) * speed * direction
  const requested = current[axis] + delta
  const nextDirection = requested >= high ? -1 : requested <= low ? 1 : direction
  return {
    position: { ...current, [axis]: Math.max(low, Math.min(high, requested)) },
    direction: nextDirection,
    moving: delta !== 0,
  }
}

/** Viewport rectangle occupied by another floating panel. */
export interface CharacterObstacle { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }

/**
 * Dock beside the team panel when width permits, otherwise reserve the space
 * below it for scrollable voice controls. The drawing itself stays click-through.
 */
export function avoidCharacterPanel(
  requested: CharacterPosition, size: CharacterSize, bounds: CharacterBounds, panel: CharacterObstacle | undefined,
): { readonly position: CharacterPosition; readonly detailsMaxHeight: number } {
  const position = fitCharacterPosition(requested, bounds)
  if (panel === undefined || position.x + size.width <= panel.left - 12 || position.x >= panel.right + 12) {
    return { position, detailsMaxHeight: 240 }
  }
  if (bounds.left + size.width <= panel.left - 12) {
    return { position: { x: bounds.left, y: position.y }, detailsMaxHeight: 240 }
  }
  if (bounds.right >= panel.right + 12) {
    return { position: { x: bounds.right, y: position.y }, detailsMaxHeight: 240 }
  }
  // On narrow displays the controls share the bottom column, so their height
  // comes from the measured space below the team panel instead of covering it.
  // Very short viewports retain a usable scroll surface and the close control.
  return {
    position: { x: position.x, y: bounds.bottom },
    detailsMaxHeight: Math.max(56, Math.min(240, bounds.bottom + size.height - 42 - panel.bottom - 12)),
  }
}
