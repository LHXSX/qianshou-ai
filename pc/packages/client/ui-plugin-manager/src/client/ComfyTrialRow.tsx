import { useEffect, useState } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { TrialKey } from './comfy-trial-locales.ts'
import css from './ComfyTrialRow.module.css'

export { zh, en } from './comfy-trial-locales.ts'
export type { TrialKey } from './comfy-trial-locales.ts'

type Props = ToolCallViewProps & { t: (key: TrialKey) => string }
const SHA = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const MAX_PNG = 16 * 1024 * 1024

interface Receipt {
  trialId: string
  graphSha256: string
  result: { sha256: string; bytes: number; width: number; height: number }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Never render call arguments: a prompt or model name may be private. */
export function privateComfyReceipt(block: ToolCallViewProps['block']): Receipt | null {
  if (!('kind' in block) || block.isError || block.content.length !== 1 || block.content[0]?.type !== 'text') return null
  let parsed: unknown
  try { parsed = JSON.parse(block.content[0].text) as unknown } catch { return null }
  const value = object(parsed)
  const result = object(value?.result)
  if (value?.status !== 'completed' || value.installable !== false || value.dispatchable !== false
    || typeof value.trialId !== 'string' || !UUID.test(value.trialId)
    || typeof value.graphSha256 !== 'string' || !SHA.test(value.graphSha256)
    || result === null || typeof result.sha256 !== 'string' || !SHA.test(result.sha256)
    || typeof result.bytes !== 'number' || !Number.isSafeInteger(result.bytes) || result.bytes < 1 || result.bytes > MAX_PNG
    || typeof result.width !== 'number' || !Number.isSafeInteger(result.width) || result.width < 1 || result.width > 1024
    || typeof result.height !== 'number' || !Number.isSafeInteger(result.height) || result.height < 1 || result.height > 1024) return null
  return { trialId: value.trialId, graphSha256: value.graphSha256,
    result: { sha256: result.sha256, bytes: result.bytes, width: result.width, height: result.height } }
}

function failureCode(block: ToolCallViewProps['block']): string | null {
  if (!('kind' in block) || !block.isError) return null
  if (typeof block.error?.code === 'string') return block.error.code
  const text = block.content.find(item => item.type === 'text')
  return text?.type === 'text' && /^[A-Z_]{5,100}$/u.test(text.text.trim()) ? text.text.trim() : null
}

function failureKey(code: string | null): TrialKey {
  switch (code) {
    case 'COMPUTE_COMFY_TRIAL_OWNER_APPROVAL_REQUIRED': return 'errorDenied'
    case 'COMPUTE_COMFY_TRIAL_PREFLIGHT_FAILED': return 'errorPreflight'
    case 'COMPUTE_COMFY_TRIAL_ALREADY_SUBMITTED':
    case 'COMPUTE_COMFY_TRIAL_PORT_BUSY': return 'errorBusy'
    case 'COMPUTE_COMFY_BACKEND_UNAVAILABLE':
    case 'COMPUTE_COMFY_WAIT_TIMEOUT':
    case 'COMPUTE_COMFY_CANCELLED':
    case 'interrupted': return 'errorUnknown'
    case 'COMPUTE_COMFY_PNG_INVALID':
    case 'COMPUTE_COMFY_BACKEND_INVALID': return 'errorOutput'
    default: return 'errorGeneral'
  }
}

/** Stream an authenticated, Host-rehashed PNG by opaque ID; never form a filesystem URL. */
async function loadPreview(receipt: Receipt, signal: AbortSignal): Promise<string> {
  const query = new URLSearchParams({ id: receipt.trialId })
  const response = await fetch(`/api/qianshou/compute/plugin-drafts/comfy-trials/image?${query}`, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal,
  })
  if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('image/png')
    || Number(response.headers.get('content-length')) > receipt.result.bytes || !response.body) throw new Error('PREVIEW_UNAVAILABLE')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > receipt.result.bytes || size > MAX_PNG) throw new Error('PREVIEW_TOO_LARGE')
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  if (size !== receipt.result.bytes) throw new Error('PREVIEW_TRUNCATED')
  return URL.createObjectURL(new Blob(chunks.map(chunk => new Uint8Array(chunk)), { type: 'image/png' }))
}

/** The creator conversation shows a verified local sample, not raw JSON or private prompt text. */
export function ComfyTrialRow({ block, inspect, t }: Props) {
  const receipt = privateComfyReceipt(block)
  const running = !('kind' in block)
  const failed = 'kind' in block && block.isError
  const [preview, setPreview] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  useEffect(() => {
    if (receipt === null) return
    const controller = new AbortController()
    let objectUrl: string | null = null
    void loadPreview(receipt, controller.signal).then((url) => {
      if (controller.signal.aborted) { URL.revokeObjectURL(url); return }
      objectUrl = url
      setPreview(url)
    }).catch(() => { if (!controller.signal.aborted) setPreviewFailed(true) })
    return () => { controller.abort(); if (objectUrl !== null) URL.revokeObjectURL(objectUrl) }
  }, [receipt?.trialId, receipt?.result.sha256])
  const state = running ? 'running' : failed || receipt === null ? 'failed' : 'completed'
  return <section className={css.card} data-tool="plugin_draft_try_comfy_sample" data-state={state}>
    <div className={css.head}>
      <span className={css.icon} aria-hidden="true">{t('iconGlyph')}</span>
      <div className={css.titleGroup}>
        <strong>{t('title')}</strong>
        <span>{t(state === 'running' ? 'running' : state === 'completed' ? 'completed' : failureKey(failureCode(block)))}</span>
      </div>
      <span className={css.privateBadge}>{t('private')}</span>
    </div>
    {receipt !== null && <div className={css.result}>
      <div className={css.meta}>
        <span>{receipt.result.width} × {receipt.result.height}</span>
        <span>{new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(receipt.result.bytes / 1024)} KB</span>
        <span>{t('digestLabel')} {receipt.result.sha256.slice(0, 12)}…</span>
      </div>
      {preview !== null ? <img className={css.preview} src={preview} alt={t('sampleAlt')} />
        : <p className={css.previewNote} role="status">{t(previewFailed ? 'previewFailed' : 'previewLoading')}</p>}
    </div>}
    <p className={css.foot}>{t('boundary')}</p>
    {inspect !== undefined && <button className={css.inspect} type="button" onClick={inspect}>{t('inspect')}</button>}
  </section>
}
