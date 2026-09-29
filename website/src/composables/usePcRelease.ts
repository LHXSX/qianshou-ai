import { onMounted, onUnmounted, ref } from "vue";
import { parsePcRelease, type PcRelease } from "../services/pcReleaseContract";

/** A missing manifest is a release state, never a reason to show an old binary. */
export function usePcRelease() {
  const release = ref<PcRelease | null>(null);
  const loading = ref(true);
  const status = ref<"pending" | "unavailable" | "ready">("pending");
  let controller: AbortController | undefined;

  async function load() {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    loading.value = true;
    status.value = "pending";
    release.value = null;
    const timer = setTimeout(() => current.abort(), 12000);
    try {
      const response = await fetch("/downloads/qianshou-pc/latest.json", {
        cache: "no-store", signal: current.signal,
      });
      if (response.status === 404) return;
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
        throw new Error("PC release feed unavailable");
      const parsed = parsePcRelease(await response.json());
      if (controller === current) {
        release.value = parsed;
        status.value = "ready";
      }
    } catch {
      if (controller === current) status.value = "unavailable";
    } finally {
      clearTimeout(timer);
      if (controller === current) loading.value = false;
    }
  }
  onMounted(load);
  onUnmounted(() => controller?.abort());
  return { release, loading, status, load };
}
