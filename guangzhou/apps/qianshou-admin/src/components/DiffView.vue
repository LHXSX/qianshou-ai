<script setup lang="ts">
/**
 * `before → after` 差异展示。
 *
 * 用途有二：
 * 1. 两步确认弹窗里的预览（API.md §1.3 的 `diff`）；
 * 2. 审计详情里的 `diff: [{path,before,after}]`。
 *
 * 只负责把服务端给的值显示出来，缺失字段显示「（未提供）」而不是编造内容。
 */
import { computed } from 'vue'
import { stringifyDiffValue } from '@/utils/format'
import { flattenDiffRows, rowChanged, type DiffRow } from '@/utils/diff-rows'
import type { AuditDiffRow } from '@/api/types'

const props = defineProps<{
  before?: unknown
  after?: unknown
  /** 审计详情用的结构化差异行；提供时优先按行渲染。 */
  rows?: readonly AuditDiffRow[]
}>()

/** 结构化 diff 优先；否则把 before/after 压平对照。 */
const rows = computed<readonly DiffRow[]>(() => {
  if (props.rows !== undefined && props.rows.length > 0) {
    return props.rows.map((row) => ({
      path: row.path,
      before: stringifyDiffValue(row.before),
      after: stringifyDiffValue(row.after),
    }))
  }
  return flattenDiffRows(props.before, props.after)
})

/** 值相等的行给出视觉弱化，方便管理员只看真正变化的部分。 */
function changed(row: DiffRow): boolean {
  return rowChanged(row)
}
</script>

<template>
  <el-table :data="rows" size="small" border :max-height="320">
    <el-table-column prop="path" label="字段" width="180">
      <template #default="{ row }">
        <span class="qs-mono">{{ row.path }}</span>
      </template>
    </el-table-column>
    <el-table-column label="改前（before）" min-width="200">
      <template #default="{ row }">
        <pre class="value" :class="{ 'value--same': !changed(row) }">{{ row.before }}</pre>
      </template>
    </el-table-column>
    <el-table-column label="改后（after）" min-width="200">
      <template #default="{ row }">
        <pre class="value" :class="{ 'value--changed': changed(row), 'value--same': !changed(row) }">{{ row.after }}</pre>
      </template>
    </el-table-column>
  </el-table>
</template>

<style scoped>
.value {
  max-height: 160px;
  margin: 0;
  overflow: auto;
  font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.value--changed {
  color: #b88230;
  font-weight: 600;
}

.value--same {
  color: #909399;
}
</style>
