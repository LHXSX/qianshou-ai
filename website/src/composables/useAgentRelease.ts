import { onMounted, onUnmounted, ref } from "vue";
import { parseAgentRelease, type AgentRelease } from "../services/agentReleaseContract";

/** Own a separate request so agent feed failure cannot block ecosystem downloads. */
export function useAgentRelease() {
  const release = ref<AgentRelease | null>(null);
  const loading = ref(true);
  const error = ref("");
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function load() {
    controller?.abort();
    clearTimeout(timer);
    const current = new AbortController();
    controller = current;
    release.value = null;
    error.value = "";
    loading.value = true;
    timer = setTimeout(() => current.abort(), 15000);
    try {
      const response = await fetch("/downloads/qianshou-agent/latest.json", { cache: "no-cache", signal: current.signal });
      if (!response.ok) throw new Error("Agent release unavailable");
      const value = parseAgentRelease(await response.json());
      if (controller === current) release.value = value;
    } catch {
      if (controller === current)
        error.value = "暂时无法获取千手智能体安装包，重新获取后再下载。生态客户端下载不受影响。";
    } finally {
      if (controller === current) {
        clearTimeout(timer);
        timer = undefined;
        loading.value = false;
      }
    }
  }

  onMounted(load);
  onUnmounted(() => {
    controller?.abort();
    controller = undefined;
    clearTimeout(timer);
  });
  return { release, loading, error, load };
}
