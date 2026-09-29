import * as THREE from "three";
import { powerStationFragment } from "./powerStationShader.mjs";

/** Art-directed architectural render with real-time light transport and depth parallax. */
export function createPowerStation(scene, imageUrl, callbacks = {}) {
  let disposed = false;
  const uniforms = {
    artwork: { value: null },
    time: { value: 0 },
    aspect: { value: 1.5 },
    pointer: { value: new THREE.Vector2() },
  };
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms,
    vertexShader:
      "varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}",
    fragmentShader: powerStationFragment,
  });
  const plane = new THREE.Mesh(geometry, material);
  plane.visible = false;
  scene.add(plane);
  const texture = new THREE.TextureLoader().load(
    imageUrl,
    (loaded) => {
      if (disposed) {
        loaded.dispose();
        return;
      }
      loaded.colorSpace = THREE.SRGBColorSpace;
      uniforms.artwork.value = loaded;
      plane.visible = true;
      callbacks.onReady?.();
    },
    undefined,
    () => {
      if (!disposed) callbacks.onError?.();
    },
  );
  return {
    update(time) {
      uniforms.time.value = time;
    },
    setPointer(pointer) {
      uniforms.pointer.value.copy(pointer);
    },
    resize(aspect) {
      uniforms.aspect.value = aspect;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(plane);
      texture.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
