import { computed, onMounted, onUnmounted, ref } from "vue";
import { parseEcoRelease, type EcoRelease } from "../services/releaseContract";
import {
  parseEditorial,
  noteForRelease,
  type ReleaseNote,
} from "../services/releaseEditorial";
export function useOfficialRelease() {
  const release = ref<EcoRelease | null>(null),
    notes = ref<ReleaseNote[]>([]),
    loading = ref(true),
    notesLoading = ref(true),
    error = ref("");
  let controller: AbortController | undefined;
  async function load() {
    controller?.abort();
    const active = new AbortController();
    controller = active;
    loading.value = true;
    notesLoading.value = true;
    error.value = "";
    release.value = null;
    notes.value = [];
    const timer = setTimeout(() => active.abort(), 15000);
    const get = async (url: string) => {
      const r = await fetch(url, { cache: "no-cache", signal: active.signal });
      if (!r.ok) throw new Error("Unavailable");
      return r.json();
    };
    await Promise.allSettled([
      get("/downloads/latest/release.json")
        .then(parseEcoRelease)
        .then(
          (value) => {
            if (controller === active) release.value = value;
          },
          () => {
            if (controller === active)
              error.value = "暂时无法获取官方版本。请重新获取，或稍后再试。";
          },
        )
        .finally(() => {
          if (controller === active) loading.value = false;
        }),
      get("/website-content/ecosystem-releases.json")
        .then(parseEditorial)
        .then(
          (value) => {
            if (controller === active) notes.value = value;
          },
          () => {},
        )
        .finally(() => {
          if (controller === active) notesLoading.value = false;
        }),
    ]);
    clearTimeout(timer);
  }
  onMounted(load);
  onUnmounted(() => {
    controller?.abort();
    controller = undefined;
  });
  const currentNote = computed(() =>
    noteForRelease(notes.value, release.value),
  );
  const file = (platform: string) =>
    release.value?.downloads.find(
      (d) => d.platform === platform && d.available,
    );
  return {
    release,
    notes,
    currentNote,
    loading,
    notesLoading,
    error,
    load,
    file,
  };
}
