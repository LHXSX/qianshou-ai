/**
 * `order-agent/` —— CEO 模式（真 LLM 子代理）的 seam。
 *
 * 这一层是**可替换 V1 内建 worker** 的那一个件：`llm-worker.ts` 的 `asRunnerSeam()` 对上 V1
 * `OrderAcceptanceAgentOptions.runner`，`asWorkerSeam()` 对上编排器的 Worker 角色；
 * `owner-config.ts` 是它**唯一**的授权来源（档位 / 账户 / 工具白名单 / 预算）。
 *
 * 本目录**不接线**：`apps/qianshou-node/**` 一行未碰，接头说明见
 * `docs/dev-plan/report-C-CEO模式智能体seam.md` §③。
 */
export {
  ORDER_AGENT_DEFAULT_BUDGET,
  ORDER_AGENT_MAX_SUBAGENT_DEPTH_CEILING,
  ORDER_AGENT_OWNER_CANCEL_CODE,
  ORDER_AGENT_REFUSAL_CODES,
  ORDER_AGENT_TOOL_CATALOG,
  ORDER_AGENT_TOOL_IDS,
  ORDER_AGENT_TOOL_IMPLEMENTATIONS_SHIPPED_HERE,
  OWNER_AGENT_CONFIG_OFF,
  toolActionClasses,
  validateOwnerAgentConfig,
} from './owner-config.ts'
export type {
  OrderAgentBudget,
  OrderAgentMode,
  OrderAgentToolActionClass,
  OrderAgentToolDeclaration,
  OrderAgentToolId,
  OwnerAgentConfig,
  OwnerAgentConfigValidation,
  OwnerModelAccount,
  OwnerModelCredentialRef,
  OwnerOrderAgentMode,
} from './owner-config.ts'
export {
  CEO_AUDIT_KEEP,
  CEO_ORDER_AGENT_CODE_PREFIX,
  CEO_ORDER_AGENT_DEFAULT_CANCEL_CODE,
  CEO_ORDER_AGENT_IDENTITY,
  CEO_PRODUCT_MAX_BYTES,
  CEO_SYSTEM_PROMPT,
  CEO_TOOL_OBSERVATION_MAX_CHARS,
  CEO_UNTRUSTED_TEXT_CLOSE,
  CEO_UNTRUSTED_TEXT_NEUTRALIZED,
  CEO_UNTRUSTED_TEXT_OPEN,
  createCeoLlmWorker,
  nodeCeoArtifactWriter,
  redactSecrets,
  refusalFromOrchestrationTrace,
  renderCeoAuditLine,
  renderUntrustedTaskText,
} from './llm-worker.ts'
export type {
  CeoArtifactWriter,
  CeoAuditEntry,
  CeoAuditKind,
  CeoConversationMessage,
  CeoLlmFailure,
  CeoLlmPreflight,
  CeoLlmResult,
  CeoLlmSuccess,
  CeoLlmTotals,
  CeoLlmWorker,
  CeoLlmWorkerDescription,
  CeoLlmWorkerOptions,
  CeoModelRequest,
  CeoModelResponse,
  CeoModelToolCall,
  CeoModelTransport,
  CeoModelUsage,
  CeoToolBinding,
  CeoToolDeclaration,
  CeoToolInvocation,
  CeoToolOutcome,
} from './llm-worker.ts'
