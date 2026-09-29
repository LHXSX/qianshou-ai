/** Local full-body VRM rendering, skeletal movement, gaze, blinking and hair simulation. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { observeAvatarSpeech } from "./avatar-audio.js";
import { COMPANION_MOTION_BONES, sampleCompanionMotion } from "./companion-motion.js";
/**
 * Load an approved bundled model and animate its actual skeleton and expression morphs.
 * @param container - Transparent character slot; input controls are owned by its parent.
 * @param options - Local asset, cancellation and read-only activity/speech state.
 * @returns Resource cleanup, including the GPU context, model and observer listeners.
 */
export async function createCompanionRuntime(container, options) {
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = .9;
    container.append(renderer.domElement);
    const scene = new THREE.Scene();
    const actor = new THREE.Group();
    scene.add(actor);
    const camera = new THREE.OrthographicCamera(-.75, .75, 1.98, -.15, .05, 30);
    camera.position.set(0, .94, 5);
    camera.lookAt(0, .94, 0);
    camera.top = 1.1;
    camera.bottom = -1.1;
    scene.add(new THREE.HemisphereLight(0xebefff, 0x68606e, .65));
    const key = new THREE.DirectionalLight(0xfff1e4, 1.2);
    key.position.set(-2.5, 4, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xc4bdff, .45);
    rim.position.set(2, 2, -2);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xd2e2ff, .25);
    fill.position.set(2, 1, 3);
    scene.add(fill);
    const gazeTarget = new THREE.Object3D();
    scene.add(gazeTarget);
    gazeTarget.position.set(0, 1.5, 4);
    const pointer = { x: 0, y: 0 };
    let vrm;
    let frameId;
    let disposed = false;
    const isDisposed = () => disposed;
    let speech = { mode: 'idle', pose: 'closed', openness: 0 };
    let lastAction = '';
    let actionStarted = 0;
    let lastTime = 0;
    let nextBlink = 1.4;
    let blinkStarted = -100;
    let seconds = 0;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const unsubscribe = observeAvatarSpeech((value) => { speech = value; });
    const resize = () => {
        const box = container.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0)
            return;
        renderer.setSize(box.width, box.height, false);
        const halfWidth = 1.1 * box.width / box.height;
        camera.left = -halfWidth;
        camera.right = halfWidth;
        camera.updateProjectionMatrix();
    };
    const pointerMoved = (event) => {
        const box = container.getBoundingClientRect();
        pointer.x = THREE.MathUtils.clamp((event.clientX - box.left - box.width / 2) / Math.max(box.width, 1), -1, 1);
        pointer.y = THREE.MathUtils.clamp((event.clientY - box.top - box.height / 3) / Math.max(box.height, 1), -1, 1);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    window.addEventListener('pointermove', pointerMoved, { passive: true });
    const contextLost = (event) => { event.preventDefault(); options.onError(); dispose(); };
    renderer.domElement.addEventListener('webglcontextlost', contextLost);
    const visibilityChanged = () => {
        if (document.hidden) {
            if (frameId !== undefined)
                cancelAnimationFrame(frameId);
            frameId = undefined;
        }
        else if (!disposed && vrm !== undefined && frameId === undefined) {
            lastTime = performance.now();
            frameId = requestAnimationFrame(draw);
        }
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    function dispose() {
        if (disposed)
            return;
        disposed = true;
        if (frameId !== undefined)
            cancelAnimationFrame(frameId);
        unsubscribe();
        observer.disconnect();
        window.removeEventListener('pointermove', pointerMoved);
        document.removeEventListener('visibilitychange', visibilityChanged);
        renderer.domElement.removeEventListener('webglcontextlost', contextLost);
        options.signal.removeEventListener('abort', dispose);
        if (vrm !== undefined)
            VRMUtils.deepDispose(vrm.scene);
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
    }
    function draw(now) {
        if (disposed || vrm === undefined)
            return;
        frameId = requestAnimationFrame(draw);
        if (now - lastTime < (reduced.matches ? 100 : 1000 / 30))
            return;
        const delta = Math.min((now - lastTime) / 1000, .05);
        lastTime = now;
        seconds += delta;
        const state = options.readState();
        const action = reduced.matches ? 'idle' : state.frame.action;
        if (action !== lastAction) {
            lastAction = action;
            actionStarted = seconds;
        }
        const motion = sampleCompanionMotion({
            ...state.frame, action, moving: !reduced.matches && state.frame.moving, elapsed: seconds - actionStarted,
        });
        const bones = vrm.humanoid;
        const blend = 1 - Math.exp(-delta * 11);
        for (const name of COMPANION_MOTION_BONES) {
            const bone = bones.getNormalizedBoneNode(name);
            if (!bone)
                continue;
            const angles = motion.rotations[name];
            euler.set(angles[0], angles[1], angles[2], 'XYZ');
            quaternion.setFromEuler(euler);
            bone.quaternion.slerp(quaternion, blend);
        }
        actor.position.y = THREE.MathUtils.lerp(actor.position.y, motion.rootY * 1.7, blend);
        actor.rotation.y = THREE.MathUtils.lerp(actor.rotation.y, motion.bodyYaw, blend);
        actor.rotation.z = THREE.MathUtils.lerp(actor.rotation.z, motion.roll, blend);
        const head = bones.getNormalizedBoneNode('head');
        if (head && !reduced.matches) {
            euler.set(pointer.y * .10, pointer.x * .18, Math.sin(seconds * .7) * .014);
            quaternion.setFromEuler(euler);
            head.quaternion.slerp(quaternion, blend);
        }
        gazeTarget.position.set(pointer.x * .9, 1.5 - pointer.y * .45, 4);
        if (vrm.lookAt)
            vrm.lookAt.target = gazeTarget;
        if (seconds >= nextBlink) {
            blinkStarted = seconds;
            nextBlink = seconds + 3.2 + (Math.sin(seconds * 7) + 1) * 1.1;
        }
        const blinkPhase = (seconds - blinkStarted) / .17;
        const blink = !reduced.matches && blinkPhase >= 0 && blinkPhase < 1 ? Math.sin(blinkPhase * Math.PI) : 0;
        const expressions = vrm.expressionManager;
        if (expressions) {
            expressions.setValue('blink', blink);
            expressions.setValue('happy', state.frame.action === 'wave' ? .3 : .06);
            // Audible previews also drive the face while the conversation microphone is paused.
            const voice = speech.mode === 'audio' && !reduced.matches ? speech : { pose: 'closed', openness: 0 };
            for (const [name, pose] of [['aa', 'a'], ['ou', 'o'], ['ee', 'e']]) {
                const target = voice.pose === pose ? Math.min(.8, voice.openness) : 0;
                expressions.setValue(name, voice.pose === 'closed' ? 0 : THREE.MathUtils.lerp(expressions.getValue(name) ?? 0, target, blend));
            }
        }
        // VRM update resolves humanoid transforms, facial morphs, gaze and spring bones in order.
        vrm.update(delta);
        renderer.render(scene, camera);
    }
    options.signal.addEventListener('abort', dispose, { once: true });
    try {
        options.signal.throwIfAborted();
        const response = await fetch(options.modelUrl, { signal: options.signal, credentials: 'same-origin' });
        if (!response.ok)
            throw new Error('CHARACTER_ASSET_UNAVAILABLE');
        const bytes = await response.arrayBuffer();
        options.signal.throwIfAborted();
        const loader = new GLTFLoader();
        loader.register(parser => new VRMLoaderPlugin(parser));
        const gltf = await loader.parseAsync(bytes, '');
        const model = gltf.userData.vrm;
        if (!model) {
            VRMUtils.deepDispose(gltf.scene);
            throw new Error('CHARACTER_VRM_REQUIRED');
        }
        if (isDisposed() || options.signal.aborted) {
            VRMUtils.deepDispose(model.scene);
            options.signal.throwIfAborted();
            throw new Error('CHARACTER_DISPOSED');
        }
        vrm = model;
        VRMUtils.rotateVRM0(model);
        VRMUtils.removeUnnecessaryVertices(model.scene);
        VRMUtils.combineSkeletons(model.scene);
        const box = new THREE.Box3().setFromObject(model.scene);
        const height = box.max.y - box.min.y;
        if (!(height > .1 && Number.isFinite(height)))
            throw new Error('CHARACTER_BOUNDS_INVALID');
        model.scene.scale.multiplyScalar(1.7 / height);
        model.scene.position.y -= box.min.y * 1.7 / height;
        model.scene.traverse((object) => {
            object.frustumCulled = false;
            if (!(object instanceof THREE.Mesh))
                return;
            const surface = object.material;
            const materials = Array.isArray(surface) ? surface : [surface];
            for (const material of materials) {
                // Thin expanded-backface outlines self-intersect at hair/garment seams in the small slot.
                // Keep the original textured surfaces and facial details; omit only this extra toon pass.
                if ('isOutline' in material && material.isOutline === true)
                    material.visible = false;
            }
        });
        actor.add(model.scene);
        const state = options.readState();
        const action = reduced.matches ? 'idle' : state.frame.action;
        const initial = sampleCompanionMotion({ ...state.frame, action, moving: !reduced.matches && state.frame.moving, elapsed: 0 });
        for (const name of COMPANION_MOTION_BONES) {
            const bone = model.humanoid.getNormalizedBoneNode(name);
            if (bone)
                bone.rotation.set(...initial.rotations[name], 'XYZ');
        }
        actor.position.y = initial.rootY * 1.7;
        actor.rotation.set(0, initial.bodyYaw, initial.roll, 'XYZ');
        lastAction = action;
        model.humanoid.update();
        model.scene.updateMatrixWorld(true);
        model.springBoneManager?.reset();
        resize();
        lastTime = performance.now();
        if (!document.hidden)
            frameId = requestAnimationFrame(draw);
        return { dispose };
    }
    catch (error) {
        dispose();
        throw error;
    }
}
//# sourceMappingURL=vrm-companion-runtime.js.map