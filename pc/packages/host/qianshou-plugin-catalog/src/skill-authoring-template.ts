/** Public portable source template, embedded so packaged desktops need no source checkout. */
export const skillAuthoringTemplate = {
  "schema": "qianshou.skill-authoring-template.v1",
  "runtimeAbi": "qianshou.order-runtime.quickjs-wasm.v3",
  "runtimeCapabilities": {
    "hostFilesystem": false,
    "network": false,
    "externalProcesses": false,
    "installedDependencies": false,
    "mediaEncoder": false,
    "sourceLayout": "scripts/order_adapter 仅存当前 ABI 的自包含源码、声明和样例；不混入 node_modules、.venv 或旧 Node 入口。真实本机媒体执行器另存，保留产物回执。",
    "validation": "技能目录名不需要预登记；taskType 是包内机器标识。试用拒绝先按本机 check/reason 修复，不推断上海拒绝。输入输出必须描述 run(input) 真正返回的成果；动画计划不等于 GIF/MP4。",
  },
  "instructions": "这是技能助手使用的当前 Host 通用 v3 模板。按需求修改 run(input)、中文名称、唯一 taskType/capabilityId、输入输出声明和至少两个独立期望样例。properties/required 的机器字段名必须使用 ASCII 标识（如 text、result）；中文名称放在 title 作为表单展示标题，不把中文标题当机器字段名。run(input) 与样例也使用同一机器键。为 inputSchema.contentSchema 的 object 字段编写中文 title、必填项与范围；title 受支持，字段规则不使用 description、const、pattern、$ref。表单、本机自检和平台派单按同一份声明检查。存入扫描目录后调用 qianshou_try_local_skill。不要回退到旧版 Node 执行器。模板不是发布授权，不会创建任务、安装或收费。",
  "files": {
    "SKILL.md": "---\nname: quickjs-char-count-example\ndescription: 统计文字里的字符数量，支持中文、英文和表情符号。\nmetadata:\n  displayName: 文字统计\n  category: text\n---\n\n# 文字统计\n\n填写「文字内容」，返回字符数量。中文、英文字母和单个表情符号都按一个字符统计。\n\n技能助手通过 `qianshou_try_local_skill` 试用，选择当前扫描目录里的命令名，输入例子为 `{\"text\":\"千手AI\"}`，输出应为 `{\"count\":4}`。\n\n`scripts/order_adapter/task-definition.json` 的 `inputSchema.contentSchema` 声明中文字段名称、必填项和长度限制；本机自检、试用和平台派单都按同一份声明检查。修改任务时同时修改执行代码、输入输出声明和至少两组不同的期望样例。\n\n这是 v3 通用运行 ABI 示例。`scripts/order_adapter/src/adapter.quickjs.js` 只声明 `run(input)`，不导入宿主 API。本机样例通过后仍需独立审核和平台真实受理，才能发布接单。\n",
    "scripts/order_adapter/local-adapter.json": "{\"capabilityId\":\"text.count\",\"category\":\"text\",\"contractVersion\":\"v1\",\"inputKinds\":[\"inline\"],\"outputKind\":\"inline_json\",\"platformDispatchable\":true,\"runtime\":{\"engine\":\"quickjs-wasm\",\"version\":\"0.32.0\",\"wasmSha256\":\"105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232\"},\"schema\":\"qianshou.local-adapter-candidate.v3\",\"selfTests\":[{\"expected\":\"samples/count-one.expected.json\",\"input\":\"samples/count-one.input.json\"},{\"expected\":\"samples/count-two.expected.json\",\"input\":\"samples/count-two.input.json\"}],\"taskType\":\"qianshou_quickjs_char_count_v1\"}",
    "scripts/order_adapter/package.json": "{\"name\":\"qianshou-quickjs-char-count-example\",\"type\":\"module\",\"version\":\"0.0.1\"}",
    "scripts/order_adapter/pnpm-lock.yaml": "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: false\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
    "scripts/order_adapter/samples/count-one.expected.json": "{\"count\":4}",
    "scripts/order_adapter/samples/count-one.input.json": "{\"text\":\"千手AI\"}",
    "scripts/order_adapter/samples/count-two.expected.json": "{\"count\":3}",
    "scripts/order_adapter/samples/count-two.input.json": "{\"text\":\"你好🙂\"}",
    "scripts/order_adapter/src/adapter.quickjs.js": "function run(input) {\n  if (typeof input?.text !== 'string') throw new Error('text required')\n  return { count: [...input.text].length }\n}\n",
    "scripts/order_adapter/task-definition.json": "{\"capabilityId\":\"text.count\",\"category\":\"text\",\"description\":\"统计文字里的字符数量，支持中文、英文和表情符号。\",\"inputContract\":\"inline-json-bounded.v1\",\"inputKinds\":[\"inline\"],\"inputSchema\":{\"contentMediaType\":\"application/json\",\"contentSchema\":{\"additionalProperties\":false,\"properties\":{\"text\":{\"maxLength\":8000,\"minLength\":1,\"title\":\"文字内容\",\"type\":\"string\"}},\"required\":[\"text\"],\"title\":\"文字统计\",\"type\":\"object\"},\"maxLength\":16384,\"minLength\":1,\"title\":\"需要统计的文字\",\"type\":\"string\"},\"outputKind\":\"inline_json\",\"outputSchema\":{\"additionalProperties\":false,\"properties\":{\"count\":{\"minimum\":0,\"title\":\"字符数量\",\"type\":\"integer\"}},\"required\":[\"count\"],\"title\":\"统计结果\",\"type\":\"object\"},\"paramsSchema\":{\"additionalProperties\":false,\"properties\":{},\"required\":[],\"type\":\"object\"},\"resultStrategy\":\"buyer-confirmed-structure.v1\",\"schema\":\"qianshou.reviewed-task-definition.v1\",\"taskType\":\"qianshou_quickjs_char_count_v1\",\"title\":\"文字统计\"}"
  }
} as const
