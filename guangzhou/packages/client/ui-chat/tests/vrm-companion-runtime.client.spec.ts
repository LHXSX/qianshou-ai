// @vitest-environment jsdom
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D } from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCompanionRuntime } from '../src/client/chat/voice/vrm-companion-runtime.ts'
import { COMPANION_MOTION_BONES } from '../src/client/chat/voice/companion-motion.ts'
import type { AvatarAudioFrame } from '../src/client/chat/voice/avatar-audio.ts'

const mocks = vi.hoisted(() => ({
  parse: vi.fn(), deepDispose: vi.fn(), unsubscribe: vi.fn(), disconnect: vi.fn(),
  dispose: vi.fn(), contextLoss: vi.fn(), render: vi.fn(), cancelFrame: vi.fn(),
  request: vi.fn<(callback: FrameRequestCallback) => number>(),
  observe: vi.fn<(listener: (frame: AvatarAudioFrame) => void) => () => void>(),
}))
vi.mock('three', async (load) => {
  const actual = await load<typeof import('three')>()
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement('canvas')
    setPixelRatio() {}
    setClearColor() {}
    setSize() {}
    dispose = mocks.dispose
    forceContextLoss = mocks.contextLoss
    render = mocks.render
  } }
})
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class { register() {}; parseAsync = mocks.parse },
}))
vi.mock('@pixiv/three-vrm', () => ({
  VRMLoaderPlugin: vi.fn(),
  VRMUtils: { deepDispose: mocks.deepDispose, rotateVRM0: vi.fn(), removeUnnecessaryVertices: vi.fn(), combineSkeletons: vi.fn() },
}))
vi.mock('../src/client/chat/voice/avatar-audio.ts', () => ({ observeAvatarSpeech: mocks.observe }))

function fixture() {
  const bones = new Map(COMPANION_MOTION_BONES.map(name => [name, new Object3D()]))
  const scene = new Group()
  const surface = new MeshBasicMaterial()
  const outline = Object.assign(surface.clone(), { isOutline: true })
  scene.add(new Mesh(new BoxGeometry(0.5, 1.7, 0.2), [surface, outline]))
  const expressionValues = new Map<string, number>()
  const model = {
    scene, humanoid: { getNormalizedBoneNode: (name: typeof COMPANION_MOTION_BONES[number]) => bones.get(name), update: vi.fn() },
    springBoneManager: { reset: vi.fn() }, update: vi.fn(),
    expressionManager: {
      setValue: (name: string, value: number) => { expressionValues.set(name, value) },
      getValue: (name: string) => expressionValues.get(name),
    },
  }
  return { model, bones, surface, outline, gltf: { userData: { vrm: model }, scene } }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.parse.mockReset()
  mocks.observe.mockReturnValue(mocks.unsubscribe)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))))
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect = mocks.disconnect })
  vi.stubGlobal('requestAnimationFrame', mocks.request.mockReturnValue(1))
  vi.stubGlobal('cancelAnimationFrame', mocks.cancelFrame)
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function options(signal: AbortSignal) {
  return {
    modelUrl: '/voice-companion.vrm', signal,
    readState: () => ({ frame: { action: 'idle', facing: 'right', moving: false } as const, speaking: false }),
    onError: vi.fn(),
  }
}

describe('VRM renderer resource ownership', () => {
  it('uses actual PCM while the conversation is paused and closes all mouth shapes on cancel or system fallback', async () => {
    const { model, gltf } = fixture()
    mocks.parse.mockResolvedValue(gltf)
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const container = document.createElement('div'); document.body.append(container)
    const controller = new AbortController()
    const runtime = await createCompanionRuntime(container, options(controller.signal))
    const deliver = mocks.observe.mock.calls.at(0)?.[0]
    const draw = mocks.request.mock.calls.at(0)?.[0]
    deliver?.({ mode: 'audio', pose: 'a', openness: .8 })
    draw?.(50)
    expect(model.expressionManager.getValue('aa')).toBeGreaterThan(.2)
    expect(model.expressionManager.getValue('ee')).toBe(0)
    expect(model.expressionManager.getValue('ou')).toBe(0)
    deliver?.({ mode: 'idle', pose: 'closed', openness: 0 })
    draw?.(100)
    expect(model.expressionManager.getValue('aa')).toBe(0)
    deliver?.({ mode: 'system', pose: 'closed', openness: 0 })
    draw?.(150)
    for (const name of ['aa', 'ee', 'ou']) expect(model.expressionManager.getValue(name)).toBe(0)
    runtime.dispose()
  })

  it('starts with lowered skeletal arms, initializes scaled spring bones and disposes each resource once', async () => {
    const { model, bones, surface, outline, gltf } = fixture()
    mocks.parse.mockResolvedValue(gltf)
    const container = document.createElement('div'); document.body.append(container)
    const controller = new AbortController()
    const runtime = await createCompanionRuntime(container, options(controller.signal))
    expect(container.querySelectorAll('canvas')).toHaveLength(1)
    expect(bones.get('leftUpperArm')?.rotation.z).toBeCloseTo(-1.38)
    expect(bones.get('rightUpperArm')?.rotation.z).toBeCloseTo(1.38)
    expect(model.humanoid.update).toHaveBeenCalledOnce()
    expect(model.springBoneManager.reset).toHaveBeenCalledOnce()
    expect(surface.visible).toBe(true)
    expect(outline.visible).toBe(false)
    expect(mocks.request).toHaveBeenCalledOnce()
    runtime.dispose(); runtime.dispose(); controller.abort()
    expect(mocks.deepDispose).toHaveBeenCalledExactlyOnceWith(model.scene)
    expect(mocks.dispose).toHaveBeenCalledOnce()
    expect(mocks.contextLoss).toHaveBeenCalledOnce()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
    expect(mocks.disconnect).toHaveBeenCalledOnce()
    expect(container.querySelector('canvas')).toBeNull()
  })

  it('releases a model exactly once when cancellation happens while GLTF parsing is pending', async () => {
    const { model, gltf } = fixture()
    const parsed = Promise.withResolvers<typeof gltf>()
    mocks.parse.mockReturnValue(parsed.promise)
    const container = document.createElement('div'); document.body.append(container)
    const controller = new AbortController()
    const loading = createCompanionRuntime(container, options(controller.signal))
    await vi.waitFor(() => { expect(mocks.parse).toHaveBeenCalledOnce() })
    controller.abort()
    expect(container.querySelector('canvas')).toBeNull()
    expect(mocks.dispose).toHaveBeenCalledOnce()
    parsed.resolve(gltf)
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.deepDispose).toHaveBeenCalledExactlyOnceWith(model.scene)
    expect(mocks.dispose).toHaveBeenCalledOnce()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('cleans up after a model fetch failure and reports a lost context without retaining the renderer', async () => {
    const container = document.createElement('div'); document.body.append(container)
    const controller = new AbortController()
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 404 }))
    await expect(createCompanionRuntime(container, options(controller.signal))).rejects.toThrow('CHARACTER_ASSET_UNAVAILABLE')
    expect(container.querySelector('canvas')).toBeNull()
    expect(mocks.dispose).toHaveBeenCalledOnce()
    const { gltf } = fixture(); mocks.parse.mockResolvedValue(gltf)
    const config = options(controller.signal)
    const runtime = await createCompanionRuntime(container, config)
    container.querySelector('canvas')?.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(config.onError).toHaveBeenCalledOnce()
    expect(container.querySelector('canvas')).toBeNull()
    runtime.dispose()
    expect(mocks.dispose).toHaveBeenCalledTimes(2)
    expect(mocks.deepDispose).toHaveBeenCalledOnce()
  })
})
