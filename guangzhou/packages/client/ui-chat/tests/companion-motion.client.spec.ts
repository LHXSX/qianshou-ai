import { Euler, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import {
  COMPANION_MOTION_BONES, COMPANION_MOTION_PERIOD, sampleCompanionMotion,
  type CompanionEuler, type CompanionMotionAction, type CompanionMotionBone,
} from '../src/client/chat/voice/companion-motion.ts'

const actions: readonly CompanionMotionAction[] = ['idle', 'wave', 'walk', 'climb', 'lean', 'sit']
const pairedBones: readonly (readonly [CompanionMotionBone, CompanionMotionBone])[] = [
  ['leftShoulder', 'rightShoulder'], ['leftUpperArm', 'rightUpperArm'], ['leftLowerArm', 'rightLowerArm'],
  ['leftHand', 'rightHand'], ['leftUpperLeg', 'rightUpperLeg'], ['leftLowerLeg', 'rightLowerLeg'], ['leftFoot', 'rightFoot'],
  ['hips', 'hips'], ['spine', 'spine'], ['chest', 'chest'], ['neck', 'neck'], ['head', 'head'],
]

function rotation(value: CompanionEuler) { return new Quaternion().setFromEuler(new Euler(...value, 'XYZ')) }

/** Evaluate two actual joint transforms without a WebGL scene or fabricated image displacement. */
function armEnd(upper: CompanionEuler, lower: CompanionEuler): Vector3 {
  const upperRotation = rotation(upper)
  return new Vector3(0.3, 0, 0).applyQuaternion(upperRotation)
    .add(new Vector3(0.27, 0, 0).applyQuaternion(rotation(lower)).applyQuaternion(upperRotation))
}

describe('normalized companion skeleton motion', () => {
  it('lowers relaxed arms and actually raises the waving wrist above its shoulder', () => {
    const idle = sampleCompanionMotion({ action: 'idle', facing: 'right', moving: false, elapsed: 0 })
    const wave = sampleCompanionMotion({ action: 'wave', facing: 'right', moving: false, elapsed: 0 })
    const relaxedHand = armEnd(idle.rotations.leftUpperArm, idle.rotations.leftLowerArm)
    const raisedHand = armEnd(wave.rotations.leftUpperArm, wave.rotations.leftLowerArm)
    expect(relaxedHand.y).toBeLessThan(-0.5)
    expect(relaxedHand.x).toBeGreaterThan(0)
    expect(raisedHand.y).toBeGreaterThan(0.25)
    expect(raisedHand.x).toBeGreaterThan(0.1)
    const next = sampleCompanionMotion({ action: 'wave', facing: 'right', moving: false, elapsed: 0.3 })
    expect(next.rotations.leftHand).not.toEqual(wave.rotations.leftHand)
    expect(next.rotations.leftLowerArm).not.toEqual(wave.rotations.leftLowerArm)
    expect(next.rotations.leftUpperLeg).toEqual(wave.rotations.leftUpperLeg)
  })

  it('alternates real thigh swing and knee flexion, with arms opposite the advancing leg', () => {
    const first = sampleCompanionMotion({ action: 'walk', facing: 'right', moving: true, elapsed: 0.3 })
    const second = sampleCompanionMotion({ action: 'walk', facing: 'right', moving: true, elapsed: 0.9 })
    expect(first.rotations.leftUpperLeg[0]).toBeLessThan(-0.3)
    expect(first.rotations.rightUpperLeg[0]).toBeGreaterThan(0.3)
    expect(first.rotations.leftLowerLeg[0]).toBeGreaterThan(0.5)
    expect(first.rotations.rightLowerLeg[0]).toBeLessThan(0.1)
    expect(first.rotations.leftUpperArm[0]).toBeGreaterThan(0)
    expect(second.rotations.leftUpperLeg[0]).toBeGreaterThan(0.3)
    expect(second.rotations.rightLowerLeg[0]).toBeGreaterThan(0.5)
    expect(first.bodyYaw).toBeCloseTo(Math.PI / 2)
  })

  it('pairs a climbing reach with the opposite raised knee and alternates the supporting side', () => {
    const first = sampleCompanionMotion({ action: 'climb', facing: 'right', moving: true, elapsed: 0.5 })
    const second = sampleCompanionMotion({ action: 'climb', facing: 'right', moving: true, elapsed: 1.5 })
    expect(first.rotations.leftUpperArm[2]).toBeGreaterThan(Math.abs(first.rotations.rightUpperArm[2]))
    expect(first.rotations.rightUpperLeg[0]).toBeLessThan(first.rotations.leftUpperLeg[0])
    expect(first.rotations.rightLowerLeg[0]).toBeGreaterThan(first.rotations.leftLowerLeg[0])
    expect(second.rotations.leftUpperLeg[0]).toBeLessThan(second.rotations.rightUpperLeg[0])
    expect(second.rotations.leftLowerLeg[0]).toBeGreaterThan(second.rotations.rightLowerLeg[0])
  })

  it('reaches toward the edge while leaning, and keeps seated thighs forward with shins downward', () => {
    const lean = sampleCompanionMotion({ action: 'lean', facing: 'right', moving: false, elapsed: 0 })
    expect(armEnd(lean.rotations.leftUpperArm, lean.rotations.leftLowerArm).x).toBeGreaterThan(0.5)
    expect(lean.roll).toBeLessThan(0)
    const sit = sampleCompanionMotion({ action: 'sit', facing: 'right', moving: false, elapsed: 0 })
    const thigh = rotation(sit.rotations.leftUpperLeg)
    const lowerLeg = rotation(sit.rotations.leftLowerLeg)
    const thighDirection = new Vector3(0, -1, 0).applyQuaternion(thigh)
    const shinDirection = new Vector3(0, -1, 0).applyQuaternion(lowerLeg).applyQuaternion(thigh)
    expect(thighDirection.z).toBeGreaterThan(0.99)
    expect(Math.abs(thighDirection.y)).toBeLessThan(0.01)
    expect(shinDirection.y).toBeLessThan(-0.99)
    expect(sit.rootY).toBeLessThan(-0.2)
  })

  it.each(actions)('mirrors %s between left and right while keeping its vertical placement', (action) => {
    const right = sampleCompanionMotion({ action, facing: 'right', moving: true, elapsed: 0.37 })
    const left = sampleCompanionMotion({ action, facing: 'left', moving: true, elapsed: 0.37 })
    for (const [leftBone, rightBone] of pairedBones) {
      const value = right.rotations[rightBone]
      expect(left.rotations[leftBone]).toEqual([value[0], -value[1], -value[2]])
      const other = right.rotations[leftBone]
      expect(left.rotations[rightBone]).toEqual([other[0], -other[1], -other[2]])
    }
    expect(left.rootY).toBe(right.rootY)
    expect(left.bodyYaw).toBe(-right.bodyYaw)
    expect(left.roll).toBe(-right.roll)
  })

  it.each(actions)('loops %s continuously without a limb jump across the phase boundary', (action) => {
    const period = COMPANION_MOTION_PERIOD[action]
    const start = sampleCompanionMotion({ action, facing: 'right', moving: true, elapsed: 0 })
    const loop = sampleCompanionMotion({ action, facing: 'right', moving: true, elapsed: period })
    expect(loop).toEqual(start)
    const before = sampleCompanionMotion({ action, facing: 'right', moving: true, elapsed: period - 0.00001 })
    const after = sampleCompanionMotion({ action, facing: 'right', moving: true, elapsed: period + 0.00001 })
    for (const bone of COMPANION_MOTION_BONES) {
      const values = before.rotations[bone]
      after.rotations[bone].forEach((value, index) => { expect(Math.abs(value - (values[index] ?? 0))).toBeLessThan(0.001) })
    }
    expect(Math.abs(before.rootY - after.rootY)).toBeLessThan(0.001)
  })

  it.each(['walk', 'climb'] as const)('holds the %s limbs when travel stops rather than walking in place', (action) => {
    const first = sampleCompanionMotion({ action, facing: 'right', moving: false, elapsed: 0.15 })
    const later = sampleCompanionMotion({ action, facing: 'right', moving: false, elapsed: 0.9 })
    for (const bone of ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'] as const) {
      expect(later.rotations[bone]).toEqual(first.rotations[bone])
    }
  })

  it('keeps all sampled joints finite and within the modest anatomical range, without knee reversal', () => {
    for (const action of actions) {
      for (const facing of ['left', 'right'] as const) {
        for (let frame = 0; frame < 120; frame++) {
          const pose = sampleCompanionMotion({ action, facing, moving: true, elapsed: frame / 30 })
          expect(Object.keys(pose.rotations)).toHaveLength(COMPANION_MOTION_BONES.length)
          for (const values of Object.values(pose.rotations)) {
            for (const value of values) {
              expect(Number.isFinite(value)).toBe(true)
              expect(Math.abs(value)).toBeLessThanOrEqual(Math.PI / 2 + 0.01)
            }
          }
          for (const knee of ['leftLowerLeg', 'rightLowerLeg'] as const) {
            expect(pose.rotations[knee][0]).toBeGreaterThanOrEqual(0)
            expect(pose.rotations[knee][0]).toBeLessThanOrEqual(Math.PI / 2)
          }
          expect(Math.abs(pose.rootY)).toBeLessThan(0.25)
          expect(Math.abs(pose.roll)).toBeLessThan(0.12)
        }
      }
    }
  })

  it('handles a reset or non-finite clock without NaN and returns independently owned samples', () => {
    const input = { action: 'idle', facing: 'right', moving: false, elapsed: 0 } as const
    const first = sampleCompanionMotion(input)
    for (const elapsed of [-10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(sampleCompanionMotion({ ...input, elapsed })).toEqual(first)
    }
    const second = sampleCompanionMotion(input)
    expect(second).toEqual(first)
    expect(second.rotations).not.toBe(first.rotations)
    expect(second.rotations.leftUpperArm).not.toBe(first.rotations.leftUpperArm)
  })
})
