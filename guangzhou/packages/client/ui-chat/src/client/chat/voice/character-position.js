/**
 * Reserve up to twelve pixels around a viewport-sized character area.
 * @param viewport - Current browser viewport dimensions.
 * @param size - Measured character area, including controls.
 * @returns Nonnegative bounds, also valid when the viewport has no spare space.
 */
export function characterBounds(viewport, size) {
    const spareX = Math.max(0, viewport.width - size.width);
    const spareY = Math.max(0, viewport.height - size.height);
    const insetX = Math.min(12, spareX / 2);
    const insetY = Math.min(12, spareY / 2);
    return { left: insetX, right: spareX - insetX, top: insetY, bottom: spareY - insetY };
}
/**
 * Keep an entire character area within its current travel bounds.
 * @param position - Requested viewport position.
 * @param bounds - Current legal top-left coordinates.
 * @returns The nearest valid position.
 */
export function fitCharacterPosition(position, bounds) {
    return {
        x: Math.max(bounds.left, Math.min(bounds.right, position.x)),
        y: Math.max(bounds.top, Math.min(bounds.bottom, position.y)),
    };
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
export function advanceCharacterPosition(position, action, direction, elapsedSeconds, bounds) {
    const current = fitCharacterPosition(position, bounds);
    if (action !== 'walk' && action !== 'climb')
        return { position: current, direction, moving: false };
    const axis = action === 'walk' ? 'x' : 'y';
    const low = axis === 'x' ? bounds.left : bounds.top;
    const high = axis === 'x' ? bounds.right : bounds.bottom;
    if (high <= low)
        return { position: current, direction, moving: false };
    const speed = action === 'walk' ? 36 : 24;
    const delta = Math.max(0, Math.min(0.064, elapsedSeconds)) * speed * direction;
    const requested = current[axis] + delta;
    const nextDirection = requested >= high ? -1 : requested <= low ? 1 : direction;
    return {
        position: { ...current, [axis]: Math.max(low, Math.min(high, requested)) },
        direction: nextDirection,
        moving: delta !== 0,
    };
}
/**
 * Dock beside the team panel when width permits, otherwise reserve the space
 * below it for scrollable voice controls. The drawing itself stays click-through.
 */
export function avoidCharacterPanel(requested, size, bounds, panel) {
    const position = fitCharacterPosition(requested, bounds);
    if (panel === undefined || position.x + size.width <= panel.left - 12 || position.x >= panel.right + 12) {
        return { position, detailsMaxHeight: 240 };
    }
    if (bounds.left + size.width <= panel.left - 12) {
        return { position: { x: bounds.left, y: position.y }, detailsMaxHeight: 240 };
    }
    if (bounds.right >= panel.right + 12) {
        return { position: { x: bounds.right, y: position.y }, detailsMaxHeight: 240 };
    }
    // On narrow displays the controls share the bottom column, so their height
    // comes from the measured space below the team panel instead of covering it.
    // Very short viewports retain a usable scroll surface and the close control.
    return {
        position: { x: position.x, y: bounds.bottom },
        detailsMaxHeight: Math.max(56, Math.min(240, bounds.bottom + size.height - 42 - panel.bottom - 12)),
    };
}
//# sourceMappingURL=character-position.js.map