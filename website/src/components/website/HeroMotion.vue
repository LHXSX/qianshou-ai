<template>
  <div class="motion-composition" :class="{ ready }" aria-hidden="true">
    <img class="reactor-poster" :src="poster" alt="" fetchpriority="high" />
    <div ref="surface" class="motion-surface"></div>
  </div>
</template>
<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import poster from "../../assets/brand/compute-power-station.jpg";
const props = defineProps<{ paused: boolean }>();
const emit = defineEmits<{ (e: "ready", value: boolean): void }>();
const surface = ref<HTMLElement>(),
  ready = ref(false);
let disposed = false,
  handle: { setPaused(value: boolean): void; dispose(): void } | undefined;
watch(
  () => props.paused,
  (value) => handle?.setPaused(value),
);
onMounted(async () => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  try {
    const { mountComputeHero } = await import("../../visuals/computeHero.mjs");
    if (disposed || !surface.value) return;
    handle = mountComputeHero(surface.value, {
      onReady() {
        ready.value = true;
        emit("ready", true);
      },
      onUnavailable() {
        ready.value = false;
        emit("ready", false);
      },
    });
    handle.setPaused(props.paused);
  } catch {
    ready.value = false;
    emit("ready", false);
  }
});
onUnmounted(() => {
  disposed = true;
  handle?.dispose();
});
</script>
<style scoped>
.motion-composition {
  position: absolute;
  inset: 64px 0 100px;
  isolation: isolate;
}
.motion-surface {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 1s;
}
.motion-surface :deep(canvas) {
  width: 100%;
  height: 100%;
  display: block;
}
.ready .motion-surface {
  opacity: 1;
}
.reactor-poster {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: opacity 0.8s;
}
.ready .reactor-poster {
  opacity: 0;
}
@media (max-width: 800px) {
  .motion-composition {
    inset: 55px 0 93px;
  }
}
</style>
