/** Bounded local validation facts; no upstream response or author file contents. */
import { CatalogFailure } from './registry.ts'

const CHECKS = ['source-tree', 'source-inventory', 'dependency-lock', 'declaration',
  'runtime-entry', 'task-definition', 'package-manifest', 'samples'] as const
const REASONS = ['invalid-source', 'missing-source', 'unsafe-source', 'installed-environment',
  'dependency-lock', 'declaration-fields', 'local-only', 'runtime-abi', 'runtime-entry',
  'task-definition', 'input-schema', 'output-schema', 'package-manifest', 'sample-input', 'sample-output'] as const
const REPAIRS: Record<typeof REASONS[number], { location: string; repair: string }> = {
  'invalid-source': { location: 'scripts/order_adapter', repair: '按当前模板核对自包含源码、声明与真实样例。' },
  'missing-source': { location: 'scripts/order_adapter', repair: '补齐当前 ABI 要求的目录与文件。' },
  'unsafe-source': { location: 'scripts/order_adapter', repair: '包内只保留有界、有效相对路径的普通源码文件；不使用链接、隐藏目录或安装目录。' },
  'installed-environment': { location: 'scripts/order_adapter/node_modules or .venv', repair: '依赖安装树属于本机执行环境，须与自包含投稿源码分离；保留原本机执行器和成果，不删除它们来伪装 ABI 兼容。' },
  'dependency-lock': { location: 'scripts/order_adapter/pnpm-lock.yaml', repair: '通用 QuickJS 包使用模板的固定空锁文件，不安装第三方依赖；宿主依赖须使用对应执行 ABI。' },
  'declaration-fields': { location: 'scripts/order_adapter/local-adapter.json', repair: '沿用模板声明的字段集合、类型、标识格式与样例数量；不能加入 localRenderer、note 或其他宿主执行字段。' },
  'local-only': { location: 'scripts/order_adapter/local-adapter.json/platformDispatchable', repair: '此包声明仅本机执行。只有实现当前通用 ABI 才能使用其投稿模板，不应为了通过校验改写真实能力。' },
  'runtime-abi': { location: 'scripts/order_adapter/local-adapter.json/runtime', repair: '当前通用入口固定为 quickjs-wasm 及模板中的版本、WASM 摘要；Node、Sharp、Pillow、Swift 执行器不兼容此入口。' },
  'runtime-entry': { location: 'scripts/order_adapter/src', repair: 'v3 包只使用 adapter.quickjs.js；不能同时放入旧 adapter.mjs，或遗漏/超限当前入口。' },
  'task-definition': { location: 'scripts/order_adapter/task-definition.json', repair: '与 local-adapter 的 taskType、capabilityId、category、inputKinds、outputKind 保持一致；使用模板支持的字段与范围，输出须匹配真实执行结果。' },
  'input-schema': { location: 'scripts/order_adapter/task-definition.json/inputSchema', repair: '使用模板的封闭 JSON 字段声明和支持的 schema 关键字、范围与大小；properties/required 的机器字段名仅使用 ASCII 标识（如 text），中文显示名称放在受支持的 title。run(input) 和样例使用同一机器键；const、description、pattern、$ref 不是受支持的字段规则。' },
  'output-schema': { location: 'scripts/order_adapter/task-definition.json/outputSchema', repair: '声明 run(input) 实际返回的结构和支持的 schema 关键字；properties/required 的机器字段名仅使用 ASCII 标识（如 result），中文显示名称放在受支持的 title，并同步真实输出与样例。动画计划不能声明成 GIF/MP4 回执，const、description、pattern、$ref 不受支持。' },
  'package-manifest': { location: 'scripts/order_adapter/package.json', repair: '使用有效包名和版本、type: module，不放入安装脚本或非空依赖。' },
  'sample-input': { location: 'scripts/order_adapter/samples', repair: '样例输入须为有界合法 JSON，并满足任务声明与附件声明。' },
  'sample-output': { location: 'scripts/order_adapter/samples', repair: '样例输出须匹配真实执行结果与声明的有界文件输出。' },
}

/** Only named validation checks and fixed reasons leave the source reader. */
export interface OrderSourceDiagnostic {
  readonly check: typeof CHECKS[number]
  readonly reason: typeof REASONS[number]
}

/** Preserve the public failure code while retaining the local check for author tools. */
export class OrderSourceFailure extends CatalogFailure {
  constructor(readonly diagnostic: OrderSourceDiagnostic) { super('order-adapter-invalid') }
}

/**
 * Render a bounded local rejection across independently bundled service/tool modules.
 * @param error Source-validation failure; unrelated failures retain their original handling.
 * @returns Local-only rejection facts, or null for another failure.
 */
export function localOrderSourceRejection(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof Error) || error.message !== 'QIANSHOU_CATALOG_order-adapter-invalid') return null
  const detail = (error as { diagnostic?: OrderSourceDiagnostic }).diagnostic
  const valid = detail !== undefined && CHECKS.includes(detail.check) && REASONS.includes(detail.reason)
  const reason = valid ? detail.reason : 'invalid-source'
  return {
    status: 'rejected', stage: 'local-package-validation', code: 'order-adapter-invalid',
    check: valid ? detail.check : 'source-inventory', reason, ...REPAIRS[reason],
    platformContacted: false,
    instructions: '这是本机运行包校验拒绝，没有联系上海，也不证明名称未登记。按 check/reason 与当前模板修复包；不要换名、替换成无关示例或要求人工登记。QuickJS 只运行声明的纯函数和受限文件 ABI；需要 Node、Sharp、Pillow、Swift 的 GIF/MP4 渲染不属于此 ABI，不能用动画计划或本机路径冒充视频交付。',
  }
}
