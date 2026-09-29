/** Qianshou account Remote owner and admission bridge for its explicitly selected cloud route. */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm-pi-ai'
import type {} from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ImageBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from 'zod'
import { AccountProtocol, AccountFailure } from './protocol.ts'
import type { AccountProtocolConfig } from './protocol.ts'
import { AccountSession } from './session.ts'
import { accountStore, ACCOUNT_ACCESS_REF } from './store.ts'
export { ACCOUNT_ACCESS_REF }
import type { AccountAlipayStart, AccountCommerce, AccountPayment, AccountRechargeOrder, AccountSnapshot, AccountWechatChannel,
  AccountWechatOrder, AccountWechatStart } from './types.ts'
import { listAlipayOrders, listWechatOrders, readAlipayOrder, readWechatChannel, readWechatOrder, rechargeAmount,
  refreshWechatOrder, retryAlipayPayment, retryWechatPayment, startWechatRecharge } from './commerce.ts'
import {
  IMAGE_MISSING_TEXT, IMAGE_READY_TEXT, IMAGE_TIMEOUT_MS, IMAGE_UNSTORED_TEXT, INTENT_TIMEOUT_MS,
  imageProgressClose, imageProgressOpen,
  INTENT_UNAVAILABLE_TEXT, LOCAL_PREVIEW_UNAVAILABLE_TEXT,
  decisionOf, imageBytesOf, latestUserFacts, localPreviewReply, mediaTypeOf, postJson, textChunks,
} from './route.ts'
import type { IntentPrevious } from './route.ts'

export type * from './types.ts'

/** The only name the picker shows. The request still uses the catalog id Guangzhou publishes. */
const PUBLIC_MODEL_NAME = '千手v4'
/**
 * Meter and compaction capacity for the local route.
 * Guangzhou admits each request against the signed-in tier; this value must not
 * be a smaller cap than that tier table.
 */
const CONTEXT_WINDOW = 1_000_000
/** Output budget sent with the request. Matches the DeepSeek thinking-mode default; Guangzhou still clamps to the published cap. */
const MAX_OUTPUT_TOKENS = 65_536
const LOGIN_REQUIRED_TEXT = '尚未登录千手账号，请打开左下角「千手账号」登录后重试。'
const ACCOUNT_UNAVAILABLE_TEXT = '千手账号暂不可用，请打开左下角「千手账号」查看登录状态后重试。'

/** Optional sibling. The account plugin reads its non-dispatchable plan, not its task APIs. */
interface ComputeIntentPreviewPort {
  previewNaturalIntent(input: { text: string; attachmentCount: number }, account: 'signed-in' | 'signed-out' | 'unknown', signal?: AbortSignal): Promise<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context { qianshouAccount: QianshouAccount }
}

/** Host service; no method returns passwords, tokens or the private TOTP challenge. */
export class QianshouAccount extends TypertRemoteService {
  static inject = ['credentials', 'settings', 'llm']
  static Config: Schema<AccountProtocolConfig> = Schema.object({
    accountOrigin: Schema.string().default('https://qianshousuanli.com'),
    gatewayBase: Schema.string().default('https://app.qianshousuanli.com/api/qianshou/ai'),
    timeoutMs: Schema.number().min(100).max(60000).default(15000),
  })
  private readonly accountSession: AccountSession
  private readonly protocol: AccountProtocol
  private readonly pendingImage = new Map<string, IntentPrevious>()
  private readonly videoAssetPlanSessions = new Set<string>()

  /** Register one Host-owned, short-lived structured video planning session.
   * The returned disposer is required even when model generation fails. This
   * only bypasses image intent classification; model transport and account
   * authentication still run through their normal route.
   */
  registerVideoAssetPlanSession(sessionId: string): () => void {
    if (!/^qianshou\.video-plan\.[0-9a-f-]{36}$/u.test(sessionId)
      || this.videoAssetPlanSessions.has(sessionId)) throw new Error('VIDEO_ASSET_PLAN_SESSION_INVALID')
    this.videoAssetPlanSessions.add(sessionId)
    return () => { this.videoAssetPlanSessions.delete(sessionId) }
  }

  constructor(ctx: Context, config: AccountProtocolConfig) {
    super(ctx, 'qianshouAccount')
    this.protocol = new AccountProtocol(config)
    this.accountSession = new AccountSession(this.protocol, accountStore(ctx.credentials))
    const session = this.accountSession
    ctx.provide('accountSession', {
      ensureAccessToken: async (): Promise<string | null> => {
        try { return await session.access() }
        catch { return null }
      },
    })
    ctx.effect(() => () => session.dispose(), 'qianshou-account: lifetime')
    ctx.effect(() => {
      const timer = setInterval(() => {
        void session.access().catch(() => {
          // A missed renewal leaves the refresh grant in place. The next minute tries again.
        })
      }, 60_000)
      if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') timer.unref()
      return () => { clearInterval(timer) }
    }, 'qianshou-account: renew access')
    void this.adoptRestoredCloud()
    const gatewayBase = this.protocol.gatewayBase
    ctx.on('llm-pi-ai/request-signal', async (provider, profile) => {
      if (provider !== 'qianshou-cloud' || profile.apiKeyEnv !== ACCOUNT_ACCESS_REF) return undefined
      if (profile.baseURL !== gatewayBase) throw new LlmError('千手账号路由地址不匹配，请在千手账号页重新选择千手模型。', 'QIANSHOU_ROUTE_INVALID')
      const signal = session.signal()
      await this.accountAccess()
      if (signal.aborted) throw new LlmError('千手账号会话已结束。', 'ABORTED')
      return signal
    })
    ctx.on('llm/stream', (options, next) => this.cloudTurn(options, next))
  }

  /**
   * Ask Guangzhou whether this human sentence is conversation or a picture, then take only that path.
   * @param options - the assembled model request.
   * @param next - the text-model stream. Called only for a chat decision.
   * @returns The text-model stream, or a finished reply that does not call it.
   */
  private cloudTurn(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    return this.finishCloudTurn(options, next)
  }

  /** Keep a first-time sign-in prompt distinct from a previously saved session that cannot renew. */
  private async accountAccess(): Promise<string> {
    const before = await this.accountSession.snapshot()
    try { return await this.accountSession.access() }
    catch (error) {
      if (error instanceof AccountFailure && error.code === 'auth-required'
        && before.phase === 'signed-out' && !before.restorable) {
        throw new LlmError(LOGIN_REQUIRED_TEXT, 'QIANSHOU_LOGIN_REQUIRED')
      }
      throw new LlmError(ACCOUNT_UNAVAILABLE_TEXT, 'QIANSHOU_ACCOUNT_REQUIRED')
    }
  }

  private async *finishCloudTurn(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    if (options.provider !== 'qianshou-cloud' || options.purpose !== undefined
      || (options.sessionId !== undefined && this.videoAssetPlanSessions.has(options.sessionId))) {
      yield* next(); return
    }
    // The skill assistant owns plugin creation turns. Routing "制作插件" as a
    // generic compute task returns a clarification before its tools can run.
    if (options.tools?.some(tool => tool.name === 'plugin_text_statistics_create'
      || tool.name === 'plugin_draft_save'
      || tool.name === 'plugin_candidate_prepare')) { yield* next(); return }
    const facts = latestUserFacts(options.messages)
    if (facts === undefined) { yield* next(); return }
    if (options.signal?.aborted) throw new LlmError('千手账号会话已结束。', 'ABORTED')
    const sessionKey = options.sessionId ?? ''
    const previous = this.pendingImage.get(sessionKey)
    // A Guangzhou image clarification owns its follow-up. Do not reclassify "随便" locally.
    if (previous === undefined) {
      const localToolsAvailable = options.tools?.some(tool => tool.name === 'bash' || tool.name === 'pwsh') ?? false
      const preview = await this.previewFirstTurn(facts, options.signal, localToolsAvailable)
      if (preview !== undefined) { yield* textChunks(preview); return }
    }
    const access = await this.accountAccess()
    let classified: { status: number; payload: unknown }
    try {
      classified = await postJson(fetch, `${this.protocol.gatewayBase}/intent`, access, {
        text: facts.text,
        attachmentCount: facts.attachmentCount,
        ...previous === undefined ? {} : { previous },
      }, options.signal, INTENT_TIMEOUT_MS)
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('千手账号会话已结束。', 'ABORTED')
      if (error instanceof LlmError) throw error
      yield* textChunks(INTENT_UNAVAILABLE_TEXT)
      return
    }
    if (classified.status === 401) throw new LlmError(ACCOUNT_UNAVAILABLE_TEXT, 'QIANSHOU_ACCOUNT_REQUIRED')
    const decision = decisionOf(classified.payload)
    if (decision.kind === 'chat') {
      this.pendingImage.delete(sessionKey)
      yield* next()
      return
    }
    if (decision.kind === 'clarify') {
      this.pendingImage.set(sessionKey, decision.previous)
      yield* textChunks(decision.question)
      return
    }
    if (decision.kind === 'notice') {
      yield* textChunks(decision.text)
      return
    }
    this.pendingImage.delete(sessionKey)
    let stored = false
    for await (const chunk of this.generatePicture(access, decision.prompt, decision.model, options.signal)) {
      if (chunk.type === 'block-end' && chunk.block.type === 'image') stored = true
      yield chunk
    }
    if (!stored && previous !== undefined) this.pendingImage.set(sessionKey, previous)
  }

  /** Read only a local route plan. No lease, quote, charge or supply-policy change is possible here. */
  private async previewFirstTurn(facts: { text: string; attachmentCount: number }, signal?: AbortSignal,
    localToolsAvailable = false): Promise<string | undefined> {
    const compute = this.ctx.get('computeCore') as ComputeIntentPreviewPort | undefined
    if (typeof compute?.previewNaturalIntent !== 'function') return undefined
    try {
      const phase = (await this.accountSession.snapshot()).phase
      const account = phase === 'authenticated' ? 'signed-in'
        : phase === 'signed-out' || phase === 'expired' ? 'signed-out' : 'unknown'
      const decision = await compute.previewNaturalIntent(facts, account, signal)
      return localPreviewReply(decision, facts.text, localToolsAvailable)
    } catch {
      if (signal?.aborted) throw new LlmError('千手账号会话已结束。', 'ABORTED')
      return LOCAL_PREVIEW_UNAVAILABLE_TEXT
    }
  }

  private async *generatePicture(access: string, prompt: string, model: string,
    signal: AbortSignal | undefined): AsyncGenerator<StreamChunk> {
    yield* imageProgressOpen()
    let bearer = access
    let response: { status: number; payload: unknown }
    try {
      response = await postJson(fetch, `${this.protocol.gatewayBase}/images/generations`, bearer, {
        model, prompt, n: 1, response_format: 'b64_json',
      }, signal, IMAGE_TIMEOUT_MS)
      if (response.status === 401) {
        bearer = await this.accountSession.access(true)
        response = await postJson(fetch, `${this.protocol.gatewayBase}/images/generations`, bearer, {
          model, prompt, n: 1, response_format: 'b64_json',
        }, signal, IMAGE_TIMEOUT_MS)
      }
    } catch (error) {
      if (signal?.aborted) throw new LlmError('千手账号会话已结束。', 'ABORTED')
      if (error instanceof LlmError) throw error
      yield* imageProgressClose(IMAGE_MISSING_TEXT)
      return
    }
    if (response.status === 401) throw new LlmError(ACCOUNT_UNAVAILABLE_TEXT, 'QIANSHOU_ACCOUNT_REQUIRED')
    const decision = decisionOf(response.payload)
    if (response.status !== 200) {
      yield* imageProgressClose(decision.kind === 'notice' ? decision.text : IMAGE_MISSING_TEXT)
      return
    }
    const bytes = imageBytesOf(response.payload)
    const mediaType = bytes === undefined ? undefined : mediaTypeOf(bytes)
    if (bytes === undefined || mediaType === undefined) { yield* imageProgressClose(IMAGE_MISSING_TEXT); return }
    const saver = this.ctx.get('attachments') as { saveImage(input: { data: Uint8Array; mediaType: typeof mediaType; name?: string }): Promise<ImageBlock['attachment']> } | undefined
    if (saver === undefined) { yield* imageProgressClose(IMAGE_UNSTORED_TEXT); return }
    let attachment: ImageBlock['attachment']
    try {
      attachment = await saver.saveImage({ data: bytes, mediaType, name: `qianshou.${mediaType.slice('image/'.length)}` })
    } catch {
      // The picture was already produced. A storage failure must not request another one.
      yield* imageProgressClose(IMAGE_UNSTORED_TEXT)
      return
    }
    yield* imageProgressClose(IMAGE_READY_TEXT, { type: 'image', attachment })
  }

  /**
   * Read a safe account status without performing a network request.
 * @returns The current non-secret account status and route selection.
   */
  @Remote
  async state(): Promise<AccountSnapshot> {
    const selected = this.ctx.settings.get('agent-default-model') as { provider?: string } | undefined
    this.accountSession.selected(selected?.provider === 'qianshou-cloud')
    return this.accountSession.snapshot()
  }

  /**
   * Ask Shanghai to send a phone code without replacing the current account.
   * @param phone - User-entered mainland number.
   * @param purpose - Login or new-account registration.
   * @returns The detached, non-secret account status after the operation.
   */
  @Remote
  async sendPhoneCode(phone: string, purpose?: 'login' | 'register'): Promise<AccountSnapshot> {
    return this.accountSession.sendPhoneCode(phone, purpose ?? 'login')
  }

  /**
   * Sign in with a phone code, then select the Guangzhou cloud route when the account is verified.
   * @param phone - User-entered mainland number.
   * @param code - User-entered six-digit SMS code.
   * @returns The detached, non-secret account status after the operation.
   */
  @Remote
  async loginWithPhone(phone: string, code: string): Promise<AccountSnapshot> {
    this.pendingImage.clear()
    const signedIn = await this.accountSession.loginWithPhone(phone, code)
    if (signedIn.phase !== 'authenticated') return this.state()
    return this.useCloud()
  }

  /**
   * Register through Shanghai's verified phone flow and select the cloud route after authentication.
   * @param phone - User-entered mainland number.
   * @param code - Registration SMS code.
   * @returns The detached account status.
   */
  @Remote
  async registerWithPhone(phone: string, code: string): Promise<AccountSnapshot> {
    this.pendingImage.clear()
    const signedIn = await this.accountSession.registerWithPhone(phone, code)
    if (signedIn.phase !== 'authenticated') return this.state()
    return this.useCloud()
  }

  /**
   * Sign in through the authoritative account service, then select the Guangzhou cloud route.
   * @param username - Account name or email.
   * @param password - Ephemeral password submitted only to the account authority.
   * @returns The detached, non-secret account status after the operation.
   */
  @Remote
  async login(username: string, password: string): Promise<AccountSnapshot> {
    this.pendingImage.clear()
    const signedIn = await this.accountSession.login(username, password)
    if (signedIn.phase !== 'authenticated') return this.state()
    return this.useCloud()
  }

  /**
   * Complete the Host-owned pending challenge without sending its token to the browser.
   * @param code - User-entered six-digit TOTP code.
   * @param trustDevice - Whether the authority may retain trust for this device.
   * @returns The detached, non-secret account status after the operation.
   */
  @Remote
  async completeTotp(code: string, trustDevice: boolean): Promise<AccountSnapshot> {
    this.pendingImage.clear()
    const signedIn = await this.accountSession.completeTotp(code, trustDevice)
    if (signedIn.phase !== 'authenticated') return this.state()
    return this.useCloud()
  }

  /**
   * Cancel an authorization attempt and discard any partially stored login.
   * @returns The detached, non-secret account status after the operation.
   */
  @Remote
  async cancel(): Promise<AccountSnapshot> {
    this.pendingImage.clear()
    await this.accountSession.cancel()
    return this.state()
  }

  /**
   * Refresh if necessary, verify identity, and read the authenticated Guangzhou model catalog.
   * @returns The detached, non-secret account status after the operation.
   */
  @Remote
  async reconnect(): Promise<AccountSnapshot> { await this.accountSession.reconnect(); return this.state() }

  /**
   * Read the signed-in plan, five-hour window, and RMB wallet.
   * @returns Server-reported commerce figures.
   */
  @Remote
  async billing(): Promise<AccountCommerce> { return this.accountSession.billing() }

  /**
   * Price one month of a plan without debiting the wallet.
   * @param tier - `basic`, `plus`, or `max`.
   * @returns The commerce view including the unpaid quote.
   */
  @Remote
  async quotePlan(tier: string): Promise<AccountCommerce> { return this.accountSession.quotePlan(tier) }

  /**
   * Pay the quote last shown to this account.
   * @returns The commerce view after the purchase attempt.
   */
  @Remote
  async buyPlan(): Promise<AccountCommerce> { return this.accountSession.buyPlan() }

  /**
   * Start an Alipay recharge. The browser submits the returned page.
   * @param amount - Yuan amount entered by the user.
   * @returns Reviewed Alipay fields.
   * @param idempotencyKey - The account-bound key for this explicitly requested recharge.
   * @param replay - Explicit replay intent; unavailable idempotency support must not create a duplicate.
   */
  @Remote
  async startRecharge(amount: string, idempotencyKey: string, replay: boolean): Promise<AccountAlipayStart> {
    if (typeof replay !== 'boolean') throw new AccountFailure('invalid-input')
    return this.accountSession.startRecharge(amount, idempotencyKey, replay)
  }

  /** Require the account owner before forwarding a payment request to Shanghai. */
  private async paymentContext(): Promise<{ access: string; accountId: string; signal: AbortSignal }> {
    const signal = this.accountSession.signal()
    const accountId = (await this.accountSession.snapshot()).account?.id
    if (accountId === undefined) throw new AccountFailure('auth-required')
    const access = await this.accountSession.access()
    if (signal.aborted || signal !== this.accountSession.signal()) throw new AccountFailure('cancelled')
    return { access, accountId, signal }
  }

  /**
   * Read the real WeChat Native channel state; missing configuration stays unavailable.
   * @returns The configured Native payment channel availability, without creating an order.
   */
  @Remote
  async wechatChannel(): Promise<AccountWechatChannel> {
    const { access, signal } = await this.paymentContext()
    return readWechatChannel(this.protocol, access, signal)
  }

  /**
   * Create one user-requested Native recharge. Never automatically retries an unknown create.
   * @param amount - The user-entered recharge amount in CNY.
   * @param idempotencyKey - The account-bound key for this explicitly requested recharge.
   * @param replay - Explicit replay intent; unavailable idempotency support must not create a duplicate.
   * @returns The original Native recharge instruction, or an explicit rejection.
   */
  @Remote
  async startWechatRecharge(amount: string, idempotencyKey: string, replay: boolean): Promise<AccountWechatStart> {
    if (typeof replay !== 'boolean') throw new AccountFailure('invalid-input')
    const { access, accountId, signal } = await this.paymentContext()
    const channel = await readWechatChannel(this.protocol, access, signal)
    if (!channel.available || (replay && !channel.rechargeIdempotency)) return { kind: 'rejected' }
    return startWechatRecharge(this.protocol, access, accountId, rechargeAmount(amount), idempotencyKey, signal)
  }

  /**
   * Check only the signed-in owner's existing order.
   * @param orderNo - The existing order identifier belonging to the current signed-in account.
   * @returns The current owner-bound order and its payment status.
   */
  @Remote
  async wechatOrder(orderNo: string): Promise<AccountWechatOrder> {
    const { access, accountId, signal } = await this.paymentContext()
    return readWechatOrder(this.protocol, access, accountId, orderNo, signal)
  }

  /**
   * Reconcile the original owner-bound order through Shanghai's WeChat query.
   * @param orderNo - The existing order identifier belonging to the current signed-in account.
   * @returns The reconciled status of the same original owner-bound order.
   */
  @Remote
  async wechatOrderRefresh(orderNo: string): Promise<AccountWechatOrder> {
    const { access, accountId, signal } = await this.paymentContext()
    return refreshWechatOrder(this.protocol, access, accountId, orderNo, signal)
  }

  /**
   * Read a bounded order list so an ambiguous create can find its original order.
   * @returns The bounded list of the current account's Native recharge orders.
   */
  @Remote
  async wechatOrders(): Promise<AccountWechatOrder[]> {
    const { access, accountId, signal } = await this.paymentContext()
    return listWechatOrders(this.protocol, access, accountId, signal)
  }

  /**
   * Regenerate only the original pending order's Native QR instruction.
   * @param orderNo - The existing order identifier belonging to the current signed-in account.
   * @returns The original pending order with its current Native QR instruction.
   */
  @Remote
  async wechatOrderPayment(orderNo: string): Promise<AccountWechatOrder> {
    const { access, accountId, signal } = await this.paymentContext()
    return retryWechatPayment(this.protocol, access, accountId, orderNo, signal)
  }

  /**
   * Check only this account's original Alipay order; browser return is not payment truth.
   * @param orderNo - The existing order identifier belonging to the current signed-in account.
   * @returns The original account-bound order and server-reported payment status.
   */
  @Remote
  async alipayOrder(orderNo: string): Promise<AccountRechargeOrder> {
    const { access, accountId, signal } = await this.paymentContext()
    return readAlipayOrder(this.protocol, access, accountId, orderNo, signal)
  }

  /**
   * Recover an ambiguous Alipay creation without issuing a second payment order.
   * @returns The current account's existing recharge orders, without creating another.
   */
  @Remote
  async alipayOrders(): Promise<AccountRechargeOrder[]> {
    const { access, accountId, signal } = await this.paymentContext()
    return listAlipayOrders(this.protocol, access, accountId, signal)
  }

  /**
   * Get cashier instructions only for the signed-in owner's pending order.
   * @param orderNo - The existing order identifier belonging to the current signed-in account.
   * @param amount - The user-entered recharge amount in CNY.
   * @returns Cashier instructions for the same pending account-bound order.
   */
  @Remote
  async alipayOrderPayment(orderNo: string, amount: string): Promise<AccountPayment> {
    const { access, accountId, signal } = await this.paymentContext()
    return retryAlipayPayment(this.protocol, access, accountId, orderNo, rechargeAmount(amount), signal)
  }

  /**
   * Revoke the captured account session and clear only this plugin's local credentials.
   * @returns The detached, non-secret account status after the operation.
   */
  @Remote
  async logout(): Promise<AccountSnapshot> {
    this.pendingImage.clear()
    await this.accountSession.logout()
    return this.state()
  }

  /**
   * Select the cloud route when a previous launch left a refresh grant.
   * Catalog failure stays on the account session; it does not reject plugin startup.
   */
  private adoptRestoredCloud(): Promise<void> {
    return this.accountSession.snapshot().then((status) => {
      if (!status.restorable) return undefined
      return this.useCloud()
    }).then(() => undefined, (error: unknown) => {
      const detail = error instanceof Error ? error.message : 'unknown'
      this.ctx.logger.warn(`qianshou-account: restored cloud selection did not finish: ${detail}`)
    })
  }

  /**
   * Configure the authenticated cloud route and default for new or unconfigured empty sessions.
   * @returns The current non-secret account status and route selection.
   */
  @Remote
  async useCloud(): Promise<AccountSnapshot> {
    const signal = this.accountSession.signal()
    const snapshot = await this.accountSession.reconnect()
    if (this.accountSession.signal() !== signal) return await this.state()
    const model = snapshot.models[0]
    if (snapshot.phase !== 'authenticated' || snapshot.failure !== null || model === undefined) return this.state()
    try {
      const previous = this.ctx.settings.get('agent-default-model') as {
        provider?: string
        model?: string
        reasoningEffort?: string
      } | undefined
      const thinkingChoice = previous?.provider === 'qianshou-cloud' && previous.model === model
        && (previous.reasoningEffort === 'off' || previous.reasoningEffort === 'high')
        ? previous.reasoningEffort
        : undefined
      await this.ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'qianshou-cloud'], value: {
        displayName: '千手', api: 'openai-completions', baseURL: this.protocol.gatewayBase,
        apiKeyEnv: ACCOUNT_ACCESS_REF, retryPolicy: { mode: 'normal', maxRetries: 1 },
        reasoning: 'high',
        compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens', thinkingFormat: 'deepseek' },
        models: [{ id: model, name: PUBLIC_MODEL_NAME, input: ['text', 'image'],
          contextWindow: CONTEXT_WINDOW, maxTokens: MAX_OUTPUT_TOKENS,
          reasoningEfforts: { off: null, high: 'high' } }],
      } }])
      if (this.accountSession.signal() !== signal) return await this.state()
      // Keep an explicit supported thinking choice across account renewal and
      // restart; a new install defaults to high and an old unknown choice drops.
      await this.ctx.settings.replace('agent-default-model', {
        provider: 'qianshou-cloud', model,
        ...thinkingChoice === undefined ? {} : { reasoningEffort: thinkingChoice },
      })
    } catch { throw new AccountFailure('storage-failed') }
    return this.state()
  }
}

export default QianshouAccount
