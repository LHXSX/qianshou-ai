<script setup lang="ts">
/**
 * 统一错误渲染。
 *
 * 映射关系严格来自 API.md §1.2，尤其是两条容易搞错的分支：
 * - `502 upstream_unavailable` → 「上游账号服务不可达」，**不说**「请重新登录」；
 * - `403 forbidden` → 明示缺失的权限键 `need`。
 * `503 dependency_unavailable` 会展开服务端给的 `module` / `missing[]` 详情。
 */
import { computed } from 'vue'
import { AdminApiError, errorHint, errorTitle } from '@/api/errors'

const props = withDefaults(defineProps<{
  error: unknown
  /**
   * 是否展示细节（模块 key、缺失接口清单）。默认**展示**。
   *
   * ⚠️ 默认值必须显式写成 `true`，不能靠 `props.showDetails !== false` 去推。
   * 原因是 Vue 对 `boolean` 类型的 prop 做**布尔转换**：**未传**时它会被赋成 `false`
   * 而不是 `undefined`（这是 framework 的行为，与 prop 叫什么名字无关）。
   * 于是 `props.showDetails !== false` 恒为假 —— 整块详情**永远不渲染**，
   * 而且完全静默（没有报错、没有警告）。
   *
   * 这条曾经真的发生过：`503 dependency_unavailable` 的「服务端报告缺失的接口」
   * 清单从来没显示过，而测试断言又恰好被另一个语法坑掩盖，最后是靠
   * 「把条件拆开单独跑」才定位到的。
   */
  showDetails?: boolean
}>(), {
  showDetails: true,
})

const apiError = computed(() => (props.error instanceof AdminApiError ? props.error : undefined))

/**
 * 细节开关。
 *
 * 名字**刻意不与 prop 同名**：同名时模板里的 `v-if` 会首选解析到 prop 绑定，
 * 本地 computed 被绕开 —— 这种遮蔽同样静默。两个坑叠在一起时极难发现，
 * 所以这里两道都堵上：prop 有显式默认值、本地绑定的名字与 prop 不同。
 */
const detailsVisible = computed(() => props.showDetails)

const title = computed(() => {
  const error = apiError.value
  if (error !== undefined) return errorTitle(error)
  return '请求失败'
})

const message = computed(() => {
  const error = apiError.value
  if (error !== undefined) return error.message
  return props.error instanceof Error ? props.error.message : String(props.error)
})

const hint = computed(() => {
  const error = apiError.value
  if (error === undefined) return ''
  return errorHint(error)
})

const alertType = computed<'error' | 'warning' | 'info'>(() => {
  const error = apiError.value
  if (error === undefined) return 'error'
  if (error.isDependencyUnavailable) return 'warning'
  if (error.isUpstreamUnavailable) return 'warning'
  if (error.isForbidden || error.isIpNotAllowed || error.isNotAnAdmin || error.isAdminDisabled) return 'error'
  return 'error'
})

const missing = computed(() => apiError.value?.details.missing ?? [])
const needKey = computed(() => apiError.value?.details.need)
const moduleKey = computed(() => apiError.value?.details.module ?? apiError.value?.details.moduleTitle)
</script>

<template>
  <el-alert :type="alertType" :closable="false" show-icon class="error-alert">
    <template #title>
      <span class="error-alert__title">{{ title }}</span>
      <el-tag v-if="apiError" size="small" effect="plain" class="error-alert__code">
        {{ apiError.status === 0 ? '网络层' : `HTTP ${apiError.status}` }} · {{ apiError.code }}
      </el-tag>
    </template>
    <div class="error-alert__body">
      <p class="error-alert__message">{{ message }}</p>

      <p v-if="needKey !== undefined" class="error-alert__line">
        缺少的权限键：<el-tag size="small" type="danger" effect="dark">{{ needKey }}</el-tag>
      </p>

      <p v-if="moduleKey !== undefined" class="error-alert__line">
        模块：<span class="qs-mono">{{ moduleKey }}</span>
      </p>

      <div v-if="detailsVisible && missing.length > 0" class="error-alert__missing">
        <div class="error-alert__missing-title">服务端报告缺失的接口（{{ missing.length }} 项）</div>
        <ul>
          <li v-for="item in missing" :key="item.interface">
            <span class="qs-mono">{{ item.interface }}</span>
            <span v-if="item.why" class="error-alert__why">—— {{ item.why }}</span>
          </li>
        </ul>
      </div>

      <p v-if="hint" class="error-alert__hint">{{ hint }}</p>
    </div>
  </el-alert>
</template>

<style scoped>
.error-alert {
  margin-bottom: 16px;
}

.error-alert__title {
  font-weight: 600;
}

.error-alert__code {
  margin-left: 8px;
  font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
}

.error-alert__body {
  line-height: 1.7;
}

.error-alert__message {
  margin: 0;
}

.error-alert__line {
  margin: 6px 0 0;
}

.error-alert__missing {
  margin-top: 10px;
}

.error-alert__missing-title {
  font-weight: 600;
}

.error-alert__missing ul {
  margin: 6px 0 0;
  padding-left: 20px;
}

.error-alert__why {
  color: #606266;
}

.error-alert__hint {
  margin: 8px 0 0;
  color: #606266;
}
</style>
