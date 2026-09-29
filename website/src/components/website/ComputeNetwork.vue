<template>
  <section id="network" class="qs-section">
    <div class="qs-wrap network-layout">
      <div>
        <p class="qs-eyebrow">03 / DISTRIBUTED AT THE CORE</p>
        <h2 class="qs-heading">分散的设备，<br />协同的计算。</h2>
        <p class="qs-description">
          设备做不到的任务，可以在确认能力、数据范围和费用后借用其他设备。机主自主决定是否接单，任务进度、结果与账目回到同一个工作空间。
        </p>
        <div class="network-switch" role="group" aria-label="切换算力使用场景">
          <button
            :class="{ active: mode === 'use' }"
            :aria-pressed="mode === 'use'"
            @click="mode = 'use'"
          >
            使用算力</button
          ><button
            :class="{ active: mode === 'share' }"
            :aria-pressed="mode === 'share'"
            @click="mode = 'share'"
          >
            贡献算力
          </button>
        </div>
        <h3 class="network-subtitle">
          {{
            mode === "use"
              ? "把任务交给适配的计算节点"
              : "按自己的节奏，让设备加入网络"
          }}
        </h3>
        <p class="network-detail">
          {{
            mode === "use"
              ? "先看可用能力、预计费用和等待状态，再确认任务。执行时可以查看进度、失败原因与最终结果。具体可用性以当前客户端为准。"
              : "在千手 PC 中选择愿意分享的能力，设置接单范围并主动开启总开关。完成后的收入以真实订单和平台账目为准。"
          }}
        </p>
        <a class="qs-link" :href="mode === 'use' ? '/ea/' : '/#/downloads'"
          >{{ mode === "use" ? "打开企业工作台" : "下载客户端，接入设备" }} ↗</a
        >
      </div>
      <div
        class="network-visual"
        aria-label="任务调度架构示意，不代表实时节点拓扑"
      >
        <svg viewBox="0 0 500 470" role="img">
          <title>应用、调度核心与异构设备的连接示意</title>
          <defs>
            <radialGradient id="network-glow">
              <stop stop-color="#5d9de8" stop-opacity=".2" />
              <stop offset="1" stop-color="#5d9de8" stop-opacity="0" />
            </radialGradient>
          </defs>
          <circle cx="250" cy="238" r="210" fill="url(#network-glow)" />
          <g class="network-rings">
            <circle cx="250" cy="238" r="180" />
            <circle cx="250" cy="238" r="115" />
            <ellipse cx="250" cy="238" rx="180" ry="70" />
            <ellipse cx="250" cy="238" rx="70" ry="180" />
          </g>
          <g class="network-lines">
            <path
              d="M250 60V238L82 322M80 148l170 90 170-90M420 322 250 238v180"
            />
          </g>
          <g class="network-packets">
            <circle r="3">
              <animateMotion
                dur="4s"
                repeatCount="indefinite"
                path="M250 60V238L82 322"
              />
            </circle>
            <circle r="3">
              <animateMotion
                dur="5s"
                repeatCount="indefinite"
                path="M80 148l170 90 170-90"
              />
            </circle>
            <circle r="3">
              <animateMotion
                dur="6s"
                repeatCount="indefinite"
                path="M420 322 250 238v180"
              />
            </circle>
          </g>
          <g class="node">
            <rect x="181" y="205" width="138" height="66" rx="10" />
            <text x="250" y="234">千手调度核心</text>
            <text class="node-caption" x="250" y="252">DISPATCH ENGINE</text>
          </g>
          <g
            class="node node-edge"
            v-for="n in nodes"
            :key="n.title"
            :transform="`translate(${n.x} ${n.y})`"
          >
            <rect x="-49" y="-23" width="98" height="46" rx="7" />
            <text y="-1">{{ n.title }}</text>
            <text class="node-caption" y="14">{{ n.subtitle }}</text>
          </g></svg
        ><span class="diagram-label">异构资源 · 统一调度 · 架构示意</span>
      </div>
    </div>
  </section>
</template>
<script setup lang="ts">
import { ref } from "vue";
const mode = ref("use");
const nodes = [
  { x: 250, y: 60, title: "应用 / API", subtitle: "TASK ENTRY" },
  { x: 80, y: 148, title: "Windows", subtitle: "CLIENT NODE" },
  { x: 420, y: 148, title: "macOS", subtitle: "CLIENT NODE" },
  { x: 82, y: 322, title: "GPU 节点", subtitle: "IMAGE / VIDEO" },
  { x: 420, y: 322, title: "计算节点", subtitle: "TOOL WORKLOAD" },
  { x: 250, y: 418, title: "结果与账目", subtitle: "OUTPUT / LEDGER" },
];
</script>
<style scoped>
.network-layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: center;
  gap: 65px;
}
.network-layout .qs-description {
  font-size: 14px;
  max-width: 470px;
}
.network-switch {
  display: inline-flex;
  border: 1px solid var(--qs-line);
  border-radius: 7px;
  padding: 4px;
  gap: 4px;
  margin: 30px 0 25px;
  background: #2d5872;
  border-color: #668aa2;
}
.network-switch button {
  border: 0;
  background: none;
  padding: 10px 23px;
  border-radius: 4px;
  font-size: 15px;
  color: #c9dce9;
  min-height: 43px;
}
.network-switch button.active {
  background: #e1eef7;
  color: #215776;
}
.network-subtitle {
  font-weight: 500;
  margin-bottom: 13px;
  font-size: 21px;
}
.network-detail {
  color: var(--qs-muted);
  max-width: 450px;
  margin-bottom: 24px;
  font-size: 16px;
  line-height: 1.9;
}
.network-visual {
  position: relative;
}
.network-visual svg {
  width: 100%;
  height: auto;
}
.network-rings {
  fill: none;
  stroke-dasharray: 3 5;
  stroke: #91c3de;
  stroke-opacity: 0.4;
  stroke-width: 1;
  animation: qs-network-flow 36s linear infinite;
}
.network-lines {
  fill: none;
  stroke: #84b6d5;
  stroke-width: 1.3;
}
.network-packets {
  fill: #bce8ff;
  filter: drop-shadow(0 0 5px #72c7ff);
}
.node rect {
  fill: #3c7797;
  stroke: #94c5e2;
  stroke-width: 1.2;
}
.node text {
  text-anchor: middle;
  fill: #f0f7fb;
  font-size: 15px;
  font-weight: 500;
}
.node .node-caption {
  font: 8px monospace;
  fill: #bddaea;
  font-size: 9px;
  letter-spacing: 0.5px;
}
.node-edge rect {
  fill: #2c5570;
  stroke: #719bb6;
}
.node-edge text {
  font-size: 13px;
}
.node-edge .node-caption {
  font-size: 8px;
}
.diagram-label {
  display: block;
  text-align: center;
  font-size: 13px;
  color: #bfd7e5;
  line-height: 1.7;
}
@media (max-width: 900px) {
  .network-layout {
    gap: 30px;
    grid-template-columns: 1fr;
  }
  .network-visual {
    max-width: 500px;
    margin: auto;
    width: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .network-packets {
    display: none;
  }
}
#network {
  background: radial-gradient(ellipse at 75% 50%, #386680, #254a63 70%);
  color: #edf5fb;
  --qs-muted: #c0d3e2;
  --qs-line: #5a809a;
  --qs-accent: #87c7ff;
}
#network .qs-eyebrow {
  color: #9dccf5;
}
@media (max-width: 1100px) {
  .network-layout {
    gap: 30px;
  }
}
@keyframes qs-network-flow {
  to {
    stroke-dashoffset: -180;
  }
}
@media (max-width: 600px) {
  .node text,
  .node-edge text {
    font-size: 20px;
  }
  .node .node-caption,
  .node-edge .node-caption {
    display: none;
  }
  .node text {
    dominant-baseline: central;
  }
}
</style>
