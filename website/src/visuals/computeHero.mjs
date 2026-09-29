import * as THREE from "three";
import reactorImage from "../assets/brand/compute-power-station.jpg";
import { createPowerStation } from "./reactor/powerStation.mjs";

/** Owns one concept scene, not live infrastructure telemetry. */
export function mountComputeHero(container, options = {}) {
  let disposed = false,
    paused = false,
    visible = true,
    raf = 0,
    last = 0,
    elapsed = 0;
  let renderer, station, observer, intersection;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5);
  camera.position.z = 1;
  const target = new THREE.Vector2(),
    current = new THREE.Vector2();
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    intersection?.disconnect();
    container.removeEventListener("pointermove", pointer);
    container.removeEventListener("pointerleave", leave);
    document.removeEventListener("visibilitychange", schedule);
    reduced.removeEventListener("change", schedule);
    renderer?.domElement.removeEventListener("webglcontextlost", lost);
    station?.dispose();
    renderer?.dispose();
    renderer?.domElement.remove();
  }
  function lost(event) {
    event.preventDefault();
    options.onUnavailable?.();
    dispose();
  }
  function pointer(event) {
    const rect = container.getBoundingClientRect();
    target.set(
      (event.clientX - rect.left) / rect.width - 0.5,
      (event.clientY - rect.top) / rect.height - 0.5,
    );
  }
  function leave() {
    target.set(0, 0);
  }
  function render() {
    if (disposed) return;
    station?.setPointer(current);
    renderer.render(scene, camera);
  }
  function active() {
    return (
      !disposed && !paused && visible && !document.hidden && !reduced.matches
    );
  }
  function schedule() {
    cancelAnimationFrame(raf);
    last = performance.now();
    if (active()) raf = requestAnimationFrame(frame);
  }
  function frame(time) {
    if (!active()) return;
    raf = requestAnimationFrame(frame);
    if (time - last < 1000 / 30) return;
    elapsed += Math.min((time - last) / 1000, 0.05);
    last = time;
    current.lerp(target, 0.045);
    station.update(elapsed);
    render();
  }
  function resize() {
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height || disposed) return;
    renderer.setSize(width, height, false);
    station?.resize(width / height);
    render();
  }
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.setClearColor(0x7894b0, 0);
    renderer.domElement.setAttribute("aria-hidden", "true");
    container.appendChild(renderer.domElement);
    station = createPowerStation(scene, reactorImage, {
      onReady() {
        if (!disposed) {
          resize();
          options.onReady?.();
        }
      },
      onError() {
        options.onUnavailable?.();
        dispose();
      },
    });
    observer = new ResizeObserver(resize);
    observer.observe(container);
    intersection = new IntersectionObserver(
      (entries) => {
        visible = entries[0].isIntersecting;
        schedule();
      },
      { threshold: 0.01 },
    );
    intersection.observe(container);
    container.addEventListener("pointermove", pointer, { passive: true });
    container.addEventListener("pointerleave", leave);
    document.addEventListener("visibilitychange", schedule);
    reduced.addEventListener("change", schedule);
    renderer.domElement.addEventListener("webglcontextlost", lost);
    resize();
    schedule();
    return {
      setPaused(value) {
        paused = value;
        schedule();
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
