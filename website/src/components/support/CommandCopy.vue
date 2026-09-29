<template>
  <div class="command-copy">
    <div class="command-copy-header"><span>{{ label }}</span><button type="button" :aria-label="`复制${label}`" @click="copy">{{ copied ? "已复制" : "复制命令" }}</button></div>
    <pre tabindex="0" :aria-label="label"><code>{{ command }}</code></pre>
    <p v-if="copyError" role="alert">复制未完成，请选中上方命令手动复制。</p>
    <span v-else class="copy-sr-only" role="status">{{ copied ? `${label}已复制` : "" }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
const props = defineProps<{ command: string; label: string }>();
const copied = ref(false);
const copyError = ref(false);
let revision = 0;
watch(() => props.command, () => { revision++; copied.value = false; copyError.value = false; });
async function copy() {
  const current = ++revision;
  const value = props.command;
  copied.value = false;
  copyError.value = false;
  try {
    await navigator.clipboard.writeText(value);
    if (current === revision) copied.value = true;
  } catch {
    if (current === revision) copyError.value = true;
  }
}
</script>

<style scoped>
.command-copy { min-width: 0; border: 1px solid #cad8e8; border-radius: 8px; background: #fff; margin: 12px 0; overflow: hidden; }
.command-copy-header { display: flex; gap: 8px; align-items: center; justify-content: space-between; flex-wrap: wrap; padding: 7px 10px; background: #edf3fa; color: #48627f; font-size: 11px; }
.command-copy button { flex: none; min-height: 34px; border: 1px solid #b9cbe1; border-radius: 6px; background: #fff; color: #215a9f; padding: 5px 10px; font: inherit; font-weight: 600; cursor: pointer; }
.command-copy button:hover { border-color: #5083c7; background: #e8f1ff; }
.command-copy button:active { background: #dae9ff; }
.command-copy pre { max-width: 100%; overflow-x: auto; white-space: pre; background: #f6f9fc; padding: 12px; margin: 0; font-size: 12px; line-height: 1.75; color: #203e64; tab-size: 2; }
.command-copy pre code { color: inherit; background: transparent; padding: 0; border: 0; }
.command-copy p { margin: 8px 10px; color: #a53d32; font-size: 12px; }
.command-copy :is(button, pre):focus-visible { outline: 3px solid #6a9ddd; outline-offset: -3px; }
.copy-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
