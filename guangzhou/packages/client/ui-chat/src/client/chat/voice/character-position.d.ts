/** Window-local coordinates and actions shared with the character renderer. */
export type CharacterAction = 'idle' | 'wave' | 'walk' | 'climb' | 'lean' | 'sit';
/** Horizontal orientation of the character, independent from pointer gaze. */
export type CharacterFacing = 'left' | 'right';
/** Presentation-only frame consumed by the character engine. */
export interface CharacterFrame {
    readonly action: CharacterAction;
    readonly facing: CharacterFacing;
    readonly moving: boolean;
}
/** Top-left viewport position in CSS pixels. */
export interface CharacterPosition {
    readonly x: number;
    readonly y: number;
}
/** Available travel area for the complete character and its control strip. */
export interface CharacterBounds {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
}
/** Dimensions in CSS pixels. */
export interface CharacterSize {
    readonly width: number;
    readonly height: number;
}
/** Direction along the currently selected movement axis. */
export type CharacterDirection = -1 | 1;
/**
 * Reserve up to twelve pixels around a viewport-sized character area.
 * @param viewport - Current browser viewport dimensions.
 * @param size - Measured character area, including controls.
 * @returns Nonnegative bounds, also valid when the viewport has no spare space.
 */
export declare function characterBounds(viewport: CharacterSize, size: CharacterSize): CharacterBounds;
/**
 * Keep an entire character area within its current travel bounds.
 * @param position - Requested viewport position.
 * @param bounds - Current legal top-left coordinates.
 * @returns The nearest valid position.
 */
export declare function fitCharacterPosition(position: CharacterPosition, bounds: CharacterBounds): CharacterPosition;
/**
 * Advance a user-selected walk or climb without jumping after a suspended tab.
 * @param position - Current top-left position.
 * @param action - Selected pose or movement.
 * @param direction - Current movement direction along its axis.
 * @param elapsedSeconds - Time since the preceding animation frame.
 * @param bounds - Current legal top-left coordinates.
 * @returns The bounded position and the direction for the next frame.
 */
export declare function advanceCharacterPosition(position: CharacterPosition, action: CharacterAction, direction: CharacterDirection, elapsedSeconds: number, bounds: CharacterBounds): {
    readonly position: CharacterPosition;
    readonly direction: CharacterDirection;
    readonly moving: boolean;
};
/** Viewport rectangle occupied by another floating panel. */
export interface CharacterObstacle {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
}
/**
 * Dock beside the team panel when width permits, otherwise reserve the space
 * below it for scrollable voice controls. The drawing itself stays click-through.
 */
export declare function avoidCharacterPanel(requested: CharacterPosition, size: CharacterSize, bounds: CharacterBounds, panel: CharacterObstacle | undefined): {
    readonly position: CharacterPosition;
    readonly detailsMaxHeight: number;
};
//# sourceMappingURL=character-position.d.ts.map