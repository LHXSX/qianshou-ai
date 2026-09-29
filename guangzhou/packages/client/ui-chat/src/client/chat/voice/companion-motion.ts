import type { VRMHumanBoneName } from '@pixiv/three-vrm'

/** Local actions owned by the companion's interaction controller. */
export type CompanionMotionAction = 'idle' | 'wave' | 'walk' | 'climb' | 'lean' | 'sit'
/** Radians, applied to a normalized bone in Three's XYZ Euler order. */
export type CompanionEuler = readonly [x: number, y: number, z: number]

/** Every sampled pose resets this complete set, so previous actions cannot leave a limb behind. */
export const COMPANION_MOTION_BONES = [
  'hips', 'spine', 'chest', 'neck', 'head', 'leftShoulder', 'rightShoulder',
  'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand',
  'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot',
] as const satisfies readonly VRMHumanBoneName[]
export type CompanionMotionBone = typeof COMPANION_MOTION_BONES[number]

/** Full pose repeat periods, in seconds; a walk contains two alternating strides. */
export const COMPANION_MOTION_PERIOD: Readonly<Record<CompanionMotionAction, number>> = {
  idle: 4, wave: 2.4, walk: 2.4, climb: 2, lean: 4, sit: 4,
}

/** The renderer owns position, elapsed time, action transitions and reduced-motion policy. */
export interface CompanionMotionInput {
  readonly action: CompanionMotionAction
  readonly facing: 'left' | 'right'
  readonly moving: boolean
  readonly elapsed: number
}

/** A target pose to interpolate, not a Three scene mutation or an inverse-kinematics solution. */
export interface CompanionMotionSample {
  readonly rotations: Readonly<Record<CompanionMotionBone, CompanionEuler>>
  /** Vertical offset as a fraction of model height; multiply before adding to the placement origin. */
  readonly rootY: number
  /** Yaw around world up, for a VRM 1 convention model facing +Z at rest. */
  readonly bodyYaw: number
  /** Small world-Z lean, separate from individual spine joints. */
  readonly roll: number
}

type Pose = Record<CompanionMotionBone, CompanionEuler>

function relaxedPose(breath: number): Pose {
  return {
    hips: [0, 0, 0], spine: [0.006 * breath, 0, 0], chest: [-0.01 * breath, 0, 0],
    neck: [0.004 * breath, 0, 0], head: [-0.008, 0, 0],
    leftShoulder: [0, 0, 0.008 * breath], rightShoulder: [0, 0, -0.008 * breath],
    leftUpperArm: [0.02, 0, -1.38 + 0.012 * breath], rightUpperArm: [0.02, 0, 1.38 - 0.012 * breath],
    leftLowerArm: [0, -0.16, 0], rightLowerArm: [0, 0.16, 0],
    leftHand: [0, 0, -0.035], rightHand: [0, 0, 0.035],
    leftUpperLeg: [-0.015, 0, 0.015], rightUpperLeg: [-0.015, 0, -0.015],
    leftLowerLeg: [0.035, 0, 0], rightLowerLeg: [0.035, 0, 0],
    leftFoot: [-0.02, 0, 0], rightFoot: [-0.02, 0, 0],
  }
}

function walk(pose: Pose, phase: number): number {
  const stride = Math.sin(phase)
  const leftKnee = 0.06 + 0.6 * Math.max(0, stride) ** 2
  const rightKnee = 0.06 + 0.6 * Math.max(0, -stride) ** 2
  pose.leftUpperLeg = [-0.38 * stride, 0, 0.02]
  pose.rightUpperLeg = [0.38 * stride, 0, -0.02]
  pose.leftLowerLeg = [leftKnee, 0, 0]
  pose.rightLowerLeg = [rightKnee, 0, 0]
  pose.leftFoot = [-0.45 * leftKnee + 0.08 * stride, 0, 0]
  pose.rightFoot = [-0.45 * rightKnee - 0.08 * stride, 0, 0]
  pose.leftUpperArm = [0.26 * stride, 0, -1.34]
  pose.rightUpperArm = [-0.26 * stride, 0, 1.34]
  pose.spine = [0.045, 0.035 * stride, 0]
  pose.chest = [-0.015, -0.025 * stride, 0]
  return 0.008 - 0.008 * Math.cos(phase * 2)
}

function climb(pose: Pose, phase: number): void {
  const leftReach = (1 + Math.sin(phase)) / 2
  const rightReach = 1 - leftReach
  pose.spine = [0.12, 0, 0]
  pose.head = [-0.1, 0, 0]
  pose.leftUpperArm = [-0.25, 0, 0.65 + 0.38 * leftReach]
  pose.rightUpperArm = [-0.25, 0, -0.65 - 0.38 * rightReach]
  pose.leftLowerArm = [0, -0.25, 0.35 + 0.2 * rightReach]
  pose.rightLowerArm = [0, 0.25, -0.35 - 0.2 * leftReach]
  pose.leftHand = [0.1, -0.08, 0]
  pose.rightHand = [0.1, 0.08, 0]
  // A high hand pairs with the opposite raised knee, preserving alternating support.
  pose.leftUpperLeg = [-0.2 - 0.75 * rightReach, 0, 0.06]
  pose.rightUpperLeg = [-0.2 - 0.75 * leftReach, 0, -0.06]
  pose.leftLowerLeg = [0.3 + 0.8 * rightReach, 0, 0]
  pose.rightLowerLeg = [0.3 + 0.8 * leftReach, 0, 0]
  pose.leftFoot = [-0.12, 0, 0]
  pose.rightFoot = [-0.12, 0, 0]
}

function mirrorBone(bone: CompanionMotionBone): CompanionMotionBone {
  // The controlled set is paired explicitly by its VRM names; central joints retain their names.
  if (bone.startsWith('left')) return `right${bone.slice(4)}` as CompanionMotionBone
  if (bone.startsWith('right')) return `left${bone.slice(5)}` as CompanionMotionBone
  return bone
}

/**
 * Sample bounded skeletal motion in the normalized VRM T-pose coordinate system.
 * VRM 1 faces +Z, anatomical left extends +X, and normalized rest rotations are identity.
 * Negative thigh X lifts a leg forward; positive knee X bends it backward, never hyperextending it.
 * @param input - Action and elapsed seconds; moving gates travel cycles, not stationary gestures.
 * @returns Fresh target rotations plus height-relative root offsets. The renderer smooths action changes.
 */
export function sampleCompanionMotion(input: CompanionMotionInput): CompanionMotionSample {
  const time = Number.isFinite(input.elapsed) ? Math.max(0, input.elapsed) : 0
  const period = COMPANION_MOTION_PERIOD[input.action]
  const phase = (time % period) / period * Math.PI * 2
  const breath = Math.sin(phase)
  const pose = relaxedPose(breath)
  let rootY = 0.002 * breath
  let bodyYaw = 0.12
  let roll = 0
  switch (input.action) {
    case 'idle': break
    case 'wave':
      pose.leftUpperArm = [0.08, 0, 0.18]
      pose.leftLowerArm = [-0.35, -0.2, 1.05 + 0.14 * Math.sin(phase * 2)]
      pose.leftHand = [0, 0.16 * Math.sin(phase * 2), 0.12 * Math.cos(phase * 2)]
      pose.head = [-0.02, 0.08, 0.025]
      break
    case 'walk':
      bodyYaw = Math.PI / 2
      if (input.moving) rootY = walk(pose, phase * 2)
      break
    case 'climb':
      bodyYaw = 0.65
      climb(pose, input.moving ? phase : 0)
      rootY = input.moving ? -0.015 + 0.008 * Math.cos(phase * 2) : -0.015
      break
    case 'lean':
      bodyYaw = 0.22; roll = -0.09
      pose.leftUpperArm = [0.08, -0.1, -0.28]
      pose.leftLowerArm = [0, -0.18, 0.24]
      pose.leftHand = [0, -0.08, 0.12]
      pose.spine = [0.025, 0, -0.025]
      pose.head = [0, -0.08, 0.07]
      break
    case 'sit':
      bodyYaw = 0.2; rootY = -0.23 + 0.001 * breath
      pose.spine = [0.06, 0, 0]
      pose.leftUpperLeg = [-Math.PI / 2, 0, 0.045]
      pose.rightUpperLeg = [-Math.PI / 2, 0, -0.045]
      pose.leftLowerLeg = [Math.PI / 2, 0, 0]
      pose.rightLowerLeg = [Math.PI / 2, 0, 0]
      pose.leftFoot = [0, 0, 0]; pose.rightFoot = [0, 0, 0]
      pose.leftUpperArm = [-0.32, 0, -1.2]; pose.rightUpperArm = [-0.32, 0, 1.2]
      pose.leftLowerArm = [0, -0.6, 0]; pose.rightLowerArm = [0, 0.6, 0]
      break
  }
  if (input.facing === 'right') return { rotations: pose, rootY, bodyYaw, roll }
  const mirrored = {} as Pose
  for (const bone of COMPANION_MOTION_BONES) {
    const [x, y, z] = pose[mirrorBone(bone)]
    mirrored[bone] = [x, -y, -z]
  }
  return { rotations: mirrored, rootY, bodyYaw: -bodyYaw, roll: -roll }
}
