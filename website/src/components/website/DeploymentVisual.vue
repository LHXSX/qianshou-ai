<template>
  <div
    class="deployment-visual"
    :class="{ private: mode === 'private' }"
    aria-hidden="true"
  >
    <svg viewBox="0 0 520 230">
      <defs>
        <linearGradient :id="'rack-' + mode" x2="0" y2="1">
          <stop stop-color="#d5e3ef" />
          <stop offset="1" stop-color="#89a9c5" />
        </linearGradient>
      </defs>
      <g class="deploy-grid" fill="none" stroke="#789ebd" stroke-opacity=".22">
        <path
          d="M30 165 260 50 490 165 260 225Z M87 137 317 197 M145 108 375 168 M203 80 432 139 M87 194 317 79 M145 223 375 108"
        />
      </g>
      <path
        v-if="mode === 'private'"
        class="boundary"
        d="M35 164 260 42 487 164 260 226Z"
        fill="none"
        stroke="#447fa7"
        stroke-dasharray="6 7"
      />
      <g class="deploy-paths" fill="none" stroke="#4a8ac3" stroke-width="2">
        <path d="M120 150 260 205 398 150 M120 150 260 83 398 150" />
      </g>
      <g class="deploy-travel">
        <circle r="4" fill="#167ee6">
          <animateMotion
            dur="5s"
            repeatCount="indefinite"
            path="M120 150 260 205 398 150"
          />
        </circle>
        <circle r="3" fill="#cc8750">
          <animateMotion
            dur="5s"
            begin="-2s"
            repeatCount="indefinite"
            path="M120 150 260 83 398 150"
          />
        </circle>
      </g>
      <g
        v-for="(rack, index) in racks"
        :key="index"
        :transform="`translate(${rack.x} ${rack.y})`"
      >
        <g class="rack-stack" :style="{ '--rack-delay': `${index * -0.8}s` }">
          <path d="M-35 0 0-18 35 0 0 18Z" fill="#bdd1e2" />
          <path d="M-35 0V-64L0-82V-18Z" fill="#9cb9d2" />
          <path d="M0-18V-82L35-64V0Z" :fill="`url(#rack-${mode})`" />
          <path d="M-35-64 0-82 35-64 0-46Z" fill="#e6eff6" />
          <path
            v-for="j in 4"
            :key="j"
            :d="`M5 ${-20 - j * 10} 28 ${-8 - j * 10}`"
            stroke="#4279a5"
            stroke-width="2"
          />
          <path
            d="M-28-54 -7-43 M-28-43 -7-32 M-28-32 -7-21"
            stroke="#e4f0fa"
            stroke-width="2"
          />
          <circle cx="24" cy="-16" r="2.5" fill="#167ee6" class="rack-led" />
        </g>
      </g>
      <g transform="translate(260 115)">
        <path d="M-42 0 0-23 42 0 0 23Z" fill="#316c9f" />
        <path
          d="M-42 0V-25L0-48 42-25V0L0 23Z"
          fill="#397eae"
          fill-opacity=".9"
        />
        <path d="M-42-25 0-48 42-25 0-2Z" fill="#7fbae0" stroke="#b1e2fa" />
        <path
          v-if="mode === 'private'"
          d="M-9-24v-8a9 9 0 0 1 18 0v8M-12-24h24v17h-24Z"
          fill="none"
          stroke="#e1f2ff"
          stroke-width="2"
        />
        <path
          v-else
          d="M-16-27 0-36 16-27 0-18Z M0-18v14 M-16-27v14L0-4 16-13v-14"
          fill="none"
          stroke="#e1f2ff"
          stroke-width="2"
        />
      </g>
    </svg>
    <div class="deployment-visual-labels">
      <span>{{ mode === "private" ? "专有网络边界" : "公网应用入口" }}</span
      ><span>统一任务调度</span
      ><span>{{ mode === "private" ? "自有计算资源" : "分布式计算资源" }}</span>
    </div>
  </div>
</template>
<script setup lang="ts">
defineProps<{ mode: "public" | "private" }>();
const racks = [
  { x: 120, y: 155 },
  { x: 398, y: 155 },
  { x: 260, y: 80 },
];
</script>
<style scoped>
.deployment-visual {
  padding: 0 0 24px;
  margin-bottom: 28px;
  border-bottom: 1px solid #cad7e3;
  background: radial-gradient(ellipse at 50% 60%, #c1d6e9aa, transparent 68%);
}
svg {
  display: block;
  width: 100%;
  height: auto;
  max-height: 230px;
}
.deployment-visual-labels {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: #4a6680;
}
.rack-stack {
  animation: rack-hover 6s ease-in-out infinite;
  animation-delay: var(--rack-delay);
}
.rack-led {
  animation: rack-led 3s ease-in-out infinite;
}
.boundary {
  animation: boundary-flow 20s linear infinite;
}
@keyframes rack-hover {
  50% {
    transform: translateY(-5px);
  }
}
@keyframes rack-led {
  50% {
    opacity: 0.35;
  }
}
@keyframes boundary-flow {
  to {
    stroke-dashoffset: -130;
  }
}
</style>
