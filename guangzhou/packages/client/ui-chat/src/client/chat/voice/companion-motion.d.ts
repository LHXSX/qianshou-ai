/** Local actions owned by the companion's interaction controller. */
export type CompanionMotionAction = 'idle' | 'wave' | 'walk' | 'climb' | 'lean' | 'sit';
/** Radians, applied to a normalized bone in Three's XYZ Euler order. */
export type CompanionEuler = readonly [x: number, y: number, z: number];
/** Every sampled pose resets this complete set, so previous actions cannot leave a limb behind. */
export declare const COMPANION_MOTION_BONES: readonly ["hips", "spine", "chest", "neck", "head", "leftShoulder", "rightShoulder", "leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm", "leftHand", "rightHand", "leftUpperLeg", "rightUpperLeg", "leftLowerLeg", "rightLowerLeg", "leftFoot", "rightFoot"];
export type CompanionMotionBone = typeof COMPANION_MOTION_BONES[number];
/** Full pose repeat periods, in seconds; a walk contains two alternating strides. */
export declare const COMPANION_MOTION_PERIOD: Readonly<Record<CompanionMotionAction, number>>;
/** The renderer owns position, elapsed time, action transitions and reduced-motion policy. */
export interface CompanionMotionInput {
    readonly action: CompanionMotionAction;
    readonly facing: 'left' | 'right';
    readonly moving: boolean;
    readonly elapsed: number;
}
/** A target pose to interpolate, not a Three scene mutation or an inverse-kinematics solution. */
export interface CompanionMotionSample {
    readonly rotations: Readonly<Record<CompanionMotionBone, CompanionEuler>>;
    /** Vertical offset as a fraction of model height; multiply before adding to the placement origin. */
    readonly rootY: number;
    /** Yaw around world up, for a VRM 1 convention model facing +Z at rest. */
    readonly bodyYaw: number;
    /** Small world-Z lean, separate from individual spine joints. */
    readonly roll: number;
}
/**
 * Sample bounded skeletal motion in the normalized VRM T-pose coordinate system.
 * VRM 1 faces +Z, anatomical left extends +X, and normalized rest rotations are identity.
 * Negative thigh X lifts a leg forward; positive knee X bends it backward, never hyperextending it.
 * @param input - Action and elapsed seconds; moving gates travel cycles, not stationary gestures.
 * @returns Fresh target rotations plus height-relative root offsets. The renderer smooths action changes.
 */
export declare function sampleCompanionMotion(input: CompanionMotionInput): CompanionMotionSample;
//# sourceMappingURL=companion-motion.d.ts.map