/**
 * `model` namespace dictionaries.
 *
 * `trigger.selectAria` intentionally matches `trigger.fallback` but remains a
 * separate key: the visible fallback label and the accessible name of
 * an unset trigger are free to diverge per locale, and folding it into
 * `trigger.aria` would announce the degenerate "Select model, current Select
 * model".
 */
/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
    'command.label': '模型',
    'command.description': '选择本会话使用的模型',
    'option.loadError': '目录加载失败：{message}',
    'option.deepseekV4Flash.description': 'deepseek-flash 的兼容别名，临时转到 DeepSeek-V4.1-Flash。',
    'option.deepseekFlash.description': 'DeepSeek-V4.1-Flash，原生支持文字和图片输入。',
    'option.deepseekV4Pro.description': 'DeepSeek-V4-Pro-0813，仅支持文字输入；与 V4.1 Flash 属于不同代模型。',
    'trigger.fallback': '选择模型',
    'trigger.loading': '正在加载模型…',
    'trigger.selectAria': '选择模型',
    'trigger.aria': '选择模型，当前 {model}',
    'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
    'menu.aria': '模型与推理等级',
    'menu.model': '模型',
    'menu.effort': '推理等级',
    'effort.providerDefault': 'Default',
    'auto.label': '自动',
    'auto.description': '按任务选择模型与思考力度',
    'auto.scope': '仅在 {provider} 的候选模型内选择；每项任务增加一次简短分配请求。',
    'auto.lastUsed': '最近使用：{model} · {effort}',
    'auto.noEffort': '默认力度',
    'auto.effort': '自动思考力度',
    'status.loading': '正在刷新模型列表…',
    'error.action': '模型操作失败：{message}',
    'action.reload': '重新加载',
    'warning.groupLoad': '{name} 加载失败：{message}',
    'empty.models': '没有可用的模型。',
    'blocked.composer': '当前模型不可用，请先选择模型',
    'empty.efforts': '当前模型未提供推理等级。',
};
/** English dictionary, checked complete against the zh key set. */
export const en = {
    'command.label': 'Model',
    'command.description': 'Select the model for this conversation',
    'option.loadError': 'Catalog failed to load: {message}',
    'option.deepseekV4Flash.description': 'Compatibility alias of deepseek-flash, temporarily routed to DeepSeek-V4.1-Flash.',
    'option.deepseekFlash.description': 'DeepSeek-V4.1-Flash with native text and image input.',
    'option.deepseekV4Pro.description': 'DeepSeek-V4-Pro-0813 with text input; a separate model generation from V4.1 Flash.',
    'trigger.fallback': 'Select model',
    'trigger.loading': 'Loading models…',
    'trigger.selectAria': 'Select model',
    'trigger.aria': 'Select model, current {model}',
    'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
    'menu.aria': 'Model and reasoning effort',
    'menu.model': 'Model',
    'menu.effort': 'Effort',
    'effort.providerDefault': 'Default',
    'auto.label': 'Auto',
    'auto.description': 'Choose model and effort for each task',
    'auto.scope': 'Choose only within {provider}; each task adds one brief routing request.',
    'auto.lastUsed': 'Last used: {model} · {effort}',
    'auto.noEffort': 'Provider default',
    'auto.effort': 'Automatic effort',
    'status.loading': 'Refreshing model list…',
    'error.action': 'Model operation failed: {message}',
    'action.reload': 'Reload',
    'warning.groupLoad': '{name} failed to load: {message}',
    'empty.models': 'No models available.',
    'blocked.composer': 'This model is unavailable — select one to continue',
    'empty.efforts': 'This model provides no reasoning effort levels.',
};
//# sourceMappingURL=locales.js.map