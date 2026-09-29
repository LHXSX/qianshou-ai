<script setup lang="ts">
/**
 * 占位模块页（技能/专家市场、发现页内容、订单与工单、模型路由）。
 *
 * 契约 §8.3–§8.5b 里这四个模块整体是 `dependency-unavailable`。
 * 页面唯一的数据来源是：
 *  1. 服务端 `503 dependency_unavailable` 响应里的 `module` / `missing[]` / `message`；
 *  2. `session/me` 就绪度里同 key 的条目。
 * **页面不编造任何业务条目**；缺口语句里一定写清「缺哪个服务、需要哪些接口」。
 *
 * 若某天属主服务就绪、服务端改为返回真实数据，本页改为如实展示原始响应，
 * 而不是继续显示占位文案（避免前端变成新的瓶颈）。
 */
import { computed, onMounted, ref } from 'vue'
import { AdminApiError } from '@/api/errors'
import { PLACEHOLDER_MODULES, probePlaceholderOverview, type PlaceholderModule } from '@/api/modules/placeholders'
import { session } from '@/session/store'
import ErrorAlert from '@/components/ErrorAlert.vue'
import { stringifyDiffValue } from '@/utils/format'

const props = defineProps<{ module: PlaceholderModule }>()

const descriptor = computed(() => PLACEHOLDER_MODULES[props.module])
const loading = ref(false)
const checked = ref(false)
const operationalError = ref<Error | undefined>(undefined)
const gap = ref<AdminApiError | undefined>(undefined)
const livePayload = ref<unknown>(undefined)

/** 就绪度条目：服务端在 `session/me` 里给出的同 key 说明。 */
const readiness = computed(() => session.readiness.find((item) => item.key === props.module))

/** 缺口来源：503 的 missing[] 优先；为空时退回就绪度的 missing[]。 */
const missing = computed(() => {
  const fromError = gap.value?.details.missing ?? []
  if (fromError.length > 0) return fromError
  return readiness.value?.missing ?? []
})

/** 缺哪个服务：服务端 503 的 module 字段；缺失则明确说明「服务端未给出 module」。 */
const missingService = computed(() => {
  const fromError = gap.value?.details.module ?? gap.value?.details.moduleTitle
  if (fromError !== undefined && fromError !== '') return fromError
  return undefined
})

const gapMessage = computed(() => gap.value?.message ?? readiness.value?.summary ?? '')

async function probe(): Promise<void> {
  loading.value = true
  operationalError.value = undefined
  gap.value = undefined
  livePayload.value = undefined
  try {
    const result = await probePlaceholderOverview(props.module)
    if (result.kind === 'dependency-unavailable') {
      gap.value = result.error
    } else {
      livePayload.value = result.payload
    }
  } catch (caught) {
    operationalError.value = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    loading.value = false
    checked.value = true
  }
}

onMounted(() => {
  void probe()
})
</script>

<template>
  <div class="qs-page">
    <div class="qs-page__head">
      <div>
        <h2 class="qs-page__title">{{ descriptor.title }}</h2>
        <p class="qs-page__desc">
          本页是占位页：该模块的属主服务尚未提供接口，因此没有任何真实条目可展示，
          也绝不会用演示数据填充。下方所有缺口信息都来自服务端响应。
        </p>
      </div>
      <el-button :loading="loading" @click="probe">重新探测服务端</el-button>
    </div>

    <el-card class="qs-card" shadow="never">
      <template #header>
        <div class="card-head">
          <span>缺口结论</span>
          <el-tag v-if="gap" type="danger" size="small">HTTP {{ gap.status }} · {{ gap.code }}</el-tag>
          <el-tag v-else-if="livePayload !== undefined" type="success" size="small">服务端已提供数据</el-tag>
        </div>
      </template>

      <el-alert v-if="loading" type="info" :closable="false" show-icon title="正在调用服务端接口…" />

      <template v-else>
        <template v-if="gap || readiness">
          <p class="conclusion">
            缺少的服务：<span class="qs-mono">{{ missingService ?? '服务端未在 module 字段中指明' }}</span>
          </p>
          <p v-if="gapMessage" class="conclusion">服务端说明：{{ gapMessage }}</p>
          <p class="conclusion">
            需要的接口：<span v-if="missing.length === 0">服务端未给出缺失接口清单（missing 为空）</span>
            <span v-else>以下 {{ missing.length }} 个</span>
          </p>
          <el-table v-if="missing.length > 0" :data="[...missing]" size="small" border class="gap-table">
            <el-table-column prop="interface" label="接口" min-width="280">
              <template #default="{ row }">
                <span class="qs-mono">{{ row.interface }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="why" label="为什么需要" min-width="220" />
          </el-table>
        </template>
        <p v-else class="qs-empty-hint">尚未取得缺口信息，请点「重新探测服务端」。</p>
      </template>
    </el-card>

    <ErrorAlert v-if="operationalError" :error="operationalError" />

    <el-card v-if="livePayload !== undefined" class="qs-card" shadow="never">
      <template #header>服务端原始响应（真实数据，前端业务视图尚未实现）</template>
      <pre class="payload">{{ stringifyDiffValue(livePayload) }}</pre>
    </el-card>

    <el-card class="qs-card" shadow="never">
      <template #header>契约里该模块对应的权限键</template>
      <div class="keys">
        <el-tag v-for="key in descriptor.permissions" :key="key" class="qs-mono" effect="plain">{{ key }}</el-tag>
      </div>
      <p class="qs-empty-hint">
        仅用于说明「服务端就绪后本页会展示什么」。页面可见性完全由服务端下发的菜单与权限决定，前端不做判断。
      </p>
    </el-card>
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.conclusion {
  margin: 0 0 6px;
  line-height: 1.7;
}

.gap-table {
  margin-top: 10px;
}

.payload {
  max-height: 420px;
  margin: 0;
  overflow: auto;
  font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.keys {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
</style>
