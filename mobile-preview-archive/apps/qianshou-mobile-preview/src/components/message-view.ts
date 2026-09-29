/**
 * Message presentation for the mobile web shell.
 *
 * The Session projection owns the source text. This module only turns that
 * text into DOM nodes: markdown is parsed as data and every node is created
 * through the DOM API, so raw HTML and unsafe link/image protocols never enter
 * the page. The copy action always uses the original text supplied by the
 * Session, preserving a lossless plain-text path for export and debugging.
 */
import type * as Md from 'mdast'
import type { ImageIntentPlan } from '@deepseek-ai/dsh-client-compute-trigger'
import type { ImageSource } from '../image-source.ts'
import { parseGfm } from '../../../../packages/client/ui-primitives/src/markdown/parse.ts'
import type { MobileWorkspaceSnapshot } from '../window/mobile-workspace-types.ts'
import { copy as t } from '../copy.ts'
import { messageSpeech, type MessageSpeechState } from '../message-speech.ts'

export interface MessagePresentationOptions {
  /** The selected Session is still reporting a running turn. */
  readonly streaming?: boolean
  /** Visible assistant text while typewriter-revealing; copy still uses the Session original. */
  readonly displayText?: (turn: MobileWorkspaceSnapshot['turns'][number]) => string
}

function text(value: string): Text { return document.createTextNode(value) }

const SVG_NS = 'http://www.w3.org/2000/svg'

function strokeIcon(className: string, draw: (svg: SVGSVGElement) => void): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '13')
  svg.setAttribute('height', '13')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.55')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.classList.add(className)
  draw(svg)
  return svg
}

function path(d: string): SVGPathElement {
  const node = document.createElementNS(SVG_NS, 'path')
  node.setAttribute('d', d)
  return node
}

function actionIcon(kind: 'copy' | 'speak' | 'stop'): SVGSVGElement {
  const icon = strokeIcon('message-action-icon', (svg) => {
    if (kind === 'copy') {
      const back = document.createElementNS(SVG_NS, 'rect')
      back.setAttribute('x', '8.4')
      back.setAttribute('y', '8.2')
      back.setAttribute('width', '10')
      back.setAttribute('height', '11.6')
      back.setAttribute('rx', '1.7')
      const front = document.createElementNS(SVG_NS, 'rect')
      front.setAttribute('x', '5.6')
      front.setAttribute('y', '4.2')
      front.setAttribute('width', '10')
      front.setAttribute('height', '11.6')
      front.setAttribute('rx', '1.7')
      svg.append(back, front)
      return
    }
    if (kind === 'stop') {
      const stop = document.createElementNS(SVG_NS, 'rect')
      stop.setAttribute('x', '6'); stop.setAttribute('y', '6')
      stop.setAttribute('width', '12'); stop.setAttribute('height', '12'); stop.setAttribute('rx', '2')
      stop.setAttribute('fill', 'currentColor'); stop.setAttribute('stroke', 'none'); svg.append(stop); return
    }
    svg.append(
      path('M4.7 9.1v5.8h3.1L12.4 19V5L7.8 9.1H4.7Z'),
      path('M15.5 9.15a3.35 3.35 0 0 1 0 5.7'),
      path('M17.7 7a6.15 6.15 0 0 1 0 10'),
    )
  })
  icon.setAttribute('width', '16')
  icon.setAttribute('height', '16')
  return icon
}

function actionButton(kind: 'copy' | 'speak', label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `message-${kind} message-action`
  button.setAttribute('aria-label', label)
  button.title = label
  const caption = document.createElement('span')
  caption.className = 'message-action-label'
  caption.textContent = label
  button.append(actionIcon(kind), caption)
  return button
}

/** Only absolute http(s) URLs can create an interactive or remote media node. */
function safeRemoteUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function appendInline(
  parent: HTMLElement, node: Md.PhrasingContent | Md.RootContent, definitions: ReadonlyMap<string, Md.Definition>,
): void {
  switch (node.type) {
    case 'text': parent.append(text(node.value)); return
    case 'html': parent.append(text(node.value)); return
    case 'break': parent.append(document.createElement('br')); return
    case 'strong': {
      const element = document.createElement('strong'); appendChildren(element, node.children, definitions); parent.append(element); return
    }
    case 'emphasis': {
      const element = document.createElement('em'); appendChildren(element, node.children, definitions); parent.append(element); return
    }
    case 'delete': {
      const element = document.createElement('del'); appendChildren(element, node.children, definitions); parent.append(element); return
    }
    case 'inlineCode': {
      const element = document.createElement('code'); element.textContent = node.value.replace(/\r?\n|\r/g, ' '); parent.append(element); return
    }
    case 'link': {
      const href = safeRemoteUrl(node.url)
      if (href === undefined) { appendChildren(parent, node.children, definitions); return }
      const element = document.createElement('a'); element.href = href; element.target = '_blank'; element.rel = 'noopener noreferrer'; appendChildren(element, node.children, definitions); parent.append(element); return
    }
    case 'linkReference': {
      const definition = definitions.get(node.identifier.toUpperCase())
      if (definition === undefined) { parent.append(text(`[${plainInline(node.children)}]`)); return }
      const href = safeRemoteUrl(definition.url)
      if (href === undefined) { appendChildren(parent, node.children, definitions); return }
      const element = document.createElement('a'); element.href = href; element.target = '_blank'; element.rel = 'noopener noreferrer'; appendChildren(element, node.children, definitions); parent.append(element); return
    }
    case 'image': {
      const src = safeRemoteUrl(node.url)
      if (src === undefined) { parent.append(text(node.alt ?? node.url)); return }
      const image = document.createElement('img'); image.src = src; image.alt = node.alt ?? ''; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; parent.append(image); return
    }
    case 'imageReference': {
      const definition = definitions.get(node.identifier.toUpperCase())
      const src = definition === undefined ? undefined : safeRemoteUrl(definition.url)
      if (src === undefined) { parent.append(text(node.alt ?? node.identifier)); return }
      const image = document.createElement('img'); image.src = src; image.alt = node.alt ?? ''; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; parent.append(image); return
    }
    // Definitions are collected before rendering and do not have visible output.
    case 'definition': return
    default:
      // GFM can grow its phrasing union. Unknown nodes are rendered as their
      // textual children where available; no unknown object is ever interpreted
      // as HTML.
      if ('children' in node && Array.isArray(node.children)) appendChildren(parent, node.children, definitions)
      else if ('value' in node && typeof node.value === 'string') parent.append(text(node.value))
  }
}

function appendChildren(
  parent: HTMLElement, children: readonly Md.PhrasingContent[] | readonly Md.RootContent[],
  definitions: ReadonlyMap<string, Md.Definition>,
): void {
  for (const child of children) appendInline(parent, child, definitions)
}

function plainInline(children: readonly Md.PhrasingContent[]): string {
  return children.map(child => child.type === 'text' ? child.value : 'value' in child && typeof child.value === 'string' ? child.value : '').join('')
}

function renderBlocks(parent: HTMLElement, blocks: readonly Md.RootContent[], definitions: ReadonlyMap<string, Md.Definition>): void {
  for (const node of blocks) {
    switch (node.type) {
      case 'paragraph': {
        const element = document.createElement('p'); appendChildren(element, node.children, definitions); parent.append(element); break
      }
      case 'heading': {
        const element = document.createElement(`h${node.depth}`); appendChildren(element, node.children, definitions); parent.append(element); break
      }
      case 'blockquote': {
        const element = document.createElement('blockquote'); renderBlocks(element, node.children, definitions); parent.append(element); break
      }
      case 'list': {
        const element = document.createElement(node.ordered ? 'ol' : 'ul'); if (node.ordered && node.start !== null && node.start !== undefined && node.start !== 1) (element as HTMLOListElement).start = node.start
        for (const item of node.children) {
          const row = document.createElement('li')
          if (item.checked !== null && item.checked !== undefined) {
            const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = item.checked; checkbox.disabled = true; row.append(checkbox, text(' '))
          }
          renderBlocks(row, item.children, definitions); element.append(row)
        }
        parent.append(element); break
      }
      case 'thematicBreak': parent.append(document.createElement('hr')); break
      case 'code': {
        const pre = document.createElement('pre'); const code = document.createElement('code')
        const language = node.lang?.match(/^[\w-]+/)?.[0]; if (language !== undefined) code.className = `language-${language}`
        code.textContent = node.value; pre.append(code); parent.append(pre); break
      }
      case 'table': {
        const wrapper = document.createElement('div'); wrapper.className = 'message-table'
        const table = document.createElement('table'); const [head, ...rows] = node.children
        if (head !== undefined) {
          const thead = document.createElement('thead'); const row = document.createElement('tr')
          head.children.forEach((cell, index) => {
            const header = document.createElement('th'); const align = node.align?.[index]
            if (align) header.style.textAlign = align
            appendChildren(header, cell.children, definitions); row.append(header)
          })
          thead.append(row); table.append(thead)
        }
        if (rows.length > 0) {
          const tbody = document.createElement('tbody')
          rows.forEach((sourceRow) => {
            const row = document.createElement('tr')
            sourceRow.children.forEach((cell, index) => {
              const body = document.createElement('td'); const align = node.align?.[index]
              if (align) body.style.textAlign = align
              appendChildren(body, cell.children, definitions); row.append(body)
            })
            tbody.append(row)
          })
          table.append(tbody)
        }
        wrapper.append(table); parent.append(wrapper); break
      }
      case 'html': parent.append(text(node.value)); break
      case 'definition': break
      default: {
        const element = document.createElement('div'); appendInline(element, node, definitions); parent.append(element); break
      }
    }
  }
}

function fenceRawMarkup(textValue: string): string {
  if (!/<svg[\s>]/i.test(textValue)) return textValue
  const wrapped = textValue.replace(/(<svg[\s\S]*?<\/svg>)/gi, '\n```\n$1\n```\n')
  return wrapped === textValue ? `\`\`\`\n${textValue}\n\`\`\`` : wrapped
}

/** Render one Session message into a safe, semantic markdown subtree. */
export function renderMessageMarkdown(textValue: string): HTMLElement {
  const root = document.createElement('div'); root.className = 'message-markdown'
  try {
    const tree = parseGfm(fenceRawMarkup(textValue))
    const definitions = new Map<string, Md.Definition>()
    for (const node of tree.children) if (node.type === 'definition') {
      const id = node.identifier.toUpperCase(); if (!definitions.has(id)) definitions.set(id, node)
    }
    renderBlocks(root, tree.children, definitions)
  } catch {
    // A partial stream can end between grammar tokens. Keeping that snapshot
    // visible as text is safer than dropping the assistant response.
    root.textContent = textValue
  }
  return root
}

/**
 * @param root - The newly materialized shared transcript, before mounting.
 * @param turns - The same Session projection used to create this transcript.
 * @param options - Whether the selected Session is still receiving updates.
 */
export function decorateMessages(root: HTMLElement, turns: MobileWorkspaceSnapshot['turns'], options: MessagePresentationOptions = {}): void {
  const records = new Map(turns.map(turn => [`mobile-turn-${turn.id}`, turn]))
  const lastTurn = turns.at(-1)
  for (const element of root.querySelectorAll<HTMLElement>('[data-testid]')) {
    const turn = records.get(element.dataset.testid ?? '')
    if (!turn) continue
    element.classList.add('message', turn.role === 'user' ? 'message-user' : 'message-assistant')
    element.dataset.role = turn.role
    element.dataset.at = String(turn.at)
    const header = document.createElement('div'); header.className = 'message-header'
    const speaker = document.createElement('span'); speaker.className = 'message-speaker'
    if (turn.role === 'user') speaker.textContent = t.messageYou
    else {
      const mark = document.createElement('span'); mark.className = 'inline-brand-mark'; mark.setAttribute('aria-hidden', 'true')
      for (const tone of ['violet', 'gold', 'pink']) { const bar = document.createElement('i'); bar.className = `brand-bar brand-bar-${tone}`; mark.append(bar) }
      speaker.append(mark, document.createTextNode(t.brand))
    }
    header.append(speaker)
    const date = new Date(turn.at)
    if (turn.at > 0 && Number.isFinite(date.getTime())) { const time = document.createElement('time'); time.dateTime = date.toISOString(); time.textContent = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(turn.at); header.append(time) }
    const body = renderMessageMarkdown(options.displayText?.(turn) ?? turn.text); body.classList.add('message-body')
    const isStreamingTurn = options.streaming === true && lastTurn?.id === turn.id && turn.role === 'assistant'
    element.classList.toggle('message-streaming', isStreamingTurn)
    const actions = document.createElement('div'); actions.className = 'message-actions'
    const copy = actionButton('copy', t.messageCopy)
    const feedback = document.createElement('span'); feedback.className = 'message-copy-status'; feedback.setAttribute('role', 'status')
    feedback.setAttribute('aria-atomic', 'true')
    const announce = (value: string, kind: 'success' | 'active' | 'error'): void => {
      feedback.dataset.feedback = kind
      feedback.textContent = value
    }
    copy.addEventListener('click', () => {
      const clipboard = (navigator as { readonly clipboard?: Pick<Clipboard, 'writeText'> }).clipboard
      if (!clipboard) { announce(t.messageCopyUnavailable, 'error'); return }
      copy.disabled = true
      void clipboard.writeText(turn.text).then(() => {
        announce(t.messageCopied, 'success')
      }, () => {
        announce(t.messageCopyFailed, 'error')
      }).finally(() => { copy.disabled = false })
    })
    actions.append(copy)
    if (turn.role === 'assistant') {
      const speak = actionButton('speak', t.messageSpeak)
      const speechKey = `${turn.id}:${turn.at}`
      const paintSpeech = (state: MessageSpeechState): void => {
        const active = state === 'playing'
        const label = active ? '停止播报' : t.messageSpeak
        speak.setAttribute('aria-busy', String(active)); speak.setAttribute('aria-pressed', String(active))
        speak.setAttribute('aria-label', label); speak.title = label
        speak.querySelector('svg')?.replaceWith(actionIcon(active ? 'stop' : 'speak'))
        const caption = speak.querySelector('.message-action-label'); if (caption) caption.textContent = label
        if (state === 'idle') return
        const message = state === 'playing' ? t.messageSpeaking : state === 'stopped' ? '已停止播报'
          : state === 'complete' ? t.messageSpoken : state === 'unavailable' ? t.messageSpeakUnavailable : t.messageSpeakFailed
        announce(message, active ? 'active' : state === 'error' || state === 'unavailable' ? 'error' : 'success')
      }
      messageSpeech.bind(speechKey, paintSpeech)
      speak.addEventListener('click', () => { messageSpeech.toggle(speechKey, turn.text, paintSpeech) })
      actions.append(speak)
    }
    actions.append(feedback); element.replaceChildren(header, body, actions)
  }
}

export interface GeneratedImageTurn {
  readonly id: string
  readonly prompt: string
  readonly dataUri: string
  readonly mimeType: string
  readonly at: number
  readonly caption: string
  readonly operation?: 'generate' | 'edit'
  readonly editSource?: ImageSource
}

/** Local image send that has not gone through the Agent Session. */
export interface PendingImageExchange {
  readonly id: string
  readonly text: string
  readonly plan: ImageIntentPlan
  readonly at: number
  readonly attachments: readonly { readonly url: string; readonly name: string }[]
  readonly sources?: readonly ImageSource[]
  phase: 'ask' | 'wait' | 'failed' | 'cancelled' | 'done'
  settled: boolean
  waitMessage: string
  waitStartedAt: number
}

function appendExchangeAttachments(parent: HTMLElement, attachments: PendingImageExchange['attachments'], onOpen?: (image: { readonly url: string; readonly name: string }) => void): void {
  if (attachments.length === 0) return
  const rail = document.createElement('div')
  rail.className = 'message-attachments'
  for (const item of attachments) {
    const img = document.createElement('img')
    img.className = 'message-attachment'
    img.alt = item.name
    img.src = item.url
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'message-attachment-open'
    open.setAttribute('aria-label', `查看原图：${item.name}`)
    open.append(img)
    open.addEventListener('click', () => { onOpen?.(item) })
    rail.append(open)
  }
  parent.append(rail)
}

function assistantSpeaker(): HTMLElement {
  const header = document.createElement('div')
  header.className = 'message-header'
  const speaker = document.createElement('span')
  speaker.className = 'message-speaker'
  const mark = document.createElement('span')
  mark.className = 'inline-brand-mark'
  mark.setAttribute('aria-hidden', 'true')
  for (const tone of ['violet', 'gold', 'pink']) {
    const bar = document.createElement('i')
    bar.className = `brand-bar brand-bar-${tone}`
    mark.append(bar)
  }
  speaker.append(mark, document.createTextNode(t.brand))
  header.append(speaker)
  return header
}

function insertByTime(root: HTMLElement, node: HTMLElement, at: number): void {
  node.dataset.at = String(at)
  let anchor: HTMLElement | null = null
  for (const child of root.children) {
    if (!(child instanceof HTMLElement)) continue
    const childAt = Number(child.dataset.at ?? Number.NaN)
    if (Number.isFinite(childAt) && childAt <= at) anchor = child
    else if (Number.isFinite(childAt) && childAt > at) break
  }
  if (anchor === null) root.prepend(node)
  else anchor.after(node)
}

function pendingUserNode(
  exchange: PendingImageExchange,
  onOpen?: (image: { readonly url: string; readonly name: string }) => void,
): HTMLElement {
  const user = document.createElement('article')
  user.className = 'message message-user pending-image-user'
  user.dataset.testid = `pending-image-user-${exchange.id}`
  const header = document.createElement('div')
  header.className = 'message-header'
  const speaker = document.createElement('span')
  speaker.className = 'message-speaker'
  speaker.textContent = t.messageYou
  header.append(speaker)
  const body = renderMessageMarkdown(exchange.text)
  body.classList.add('message-body')
  user.append(header)
  appendExchangeAttachments(user, exchange.attachments, onOpen)
  user.append(body)
  return user
}

function waitCardNode(exchange: PendingImageExchange, now: number): HTMLElement {
  const card = document.createElement('article')
  card.className = 'message message-assistant image-wait-card'
  card.dataset.testid = `image-wait-card-${exchange.id}`
  card.append(assistantSpeaker())
  const row = document.createElement('div')
  row.className = 'image-wait-row'
  const pulse = document.createElement('span')
  pulse.className = 'image-wait-pulse'
  pulse.setAttribute('aria-hidden', 'true')
  const title = document.createElement('p')
  title.className = 'image-wait-title'
  title.textContent = exchange.phase === 'failed' ? '这次出图未完成' : exchange.phase === 'cancelled' ? '已停止等待' : exchange.plan.kind === 'image.edit' ? '正在修改图片' : t.imageWaitTitle
  row.append(pulse, title)
  const copy = document.createElement('p')
  copy.className = 'image-wait-copy'
  copy.textContent = exchange.waitMessage || t.imageThinking
  const live = exchange.phase === 'wait'
  const track = document.createElement('div')
  track.className = 'image-wait-track'
  track.dataset.testid = `image-wait-progress-${exchange.id}`
  track.setAttribute('role', 'progressbar')
  track.setAttribute('aria-label', '出图进度')
  track.setAttribute('aria-valuetext', live ? '正在等待图片结果' : exchange.waitMessage)
  if (!live) {
    card.classList.add('image-wait-card-failed')
    track.setAttribute('aria-valuetext', exchange.waitMessage)
  }
  const bar = document.createElement('div')
  bar.className = 'image-wait-bar'
  bar.style.width = live ? '40%' : '0%'
  track.append(bar)
  const percentLabel = document.createElement('span')
  percentLabel.className = 'image-wait-percent'
  const seconds = Math.max(0, Math.floor((now - (exchange.waitStartedAt || exchange.at)) / 1000))
  percentLabel.textContent = live ? `已等待 ${String(seconds)} 秒` : '可以调整描述后重新发送'
  card.append(row, copy, track, percentLabel)
  return card
}

function askCardNode(exchange: PendingImageExchange): HTMLElement {
  const card = document.createElement('article')
  card.className = 'message message-assistant image-intent-card'
  card.dataset.testid = `image-intent-card-${exchange.id}`
  card.append(assistantSpeaker())
  const question = document.createElement('p')
  question.className = 'image-intent-question'
  question.textContent = exchange.plan.question
  card.append(question)
  return card
}

function generatedImageNode(
  turn: GeneratedImageTurn,
  options: { readonly onReady?: () => void; readonly onOpen?: (turn: GeneratedImageTurn) => void } = {},
): HTMLElement {
  const article = document.createElement('article')
  article.className = 'message message-assistant generated-image-turn'
  article.dataset.testid = `generated-image-${turn.id}`
  article.append(assistantSpeaker())
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'generated-image-open'
  open.dataset.testid = `generated-image-open-${turn.id}`
  open.setAttribute('aria-label', t.imageOpen)
  const img = document.createElement('img')
  img.className = 'generated-image'
  img.alt = turn.prompt
  img.src = turn.dataUri
  img.decoding = 'async'
  if (options.onReady !== undefined) {
    if (img.complete) queueMicrotask(options.onReady)
    else {
      img.addEventListener('load', options.onReady, { once: true })
      img.addEventListener('error', options.onReady, { once: true })
    }
  }
  open.append(img)
  if (options.onOpen !== undefined) {
    const handle = options.onOpen
    open.addEventListener('click', () => { handle(turn) })
  }
  const caption = document.createElement('p')
  caption.className = 'generated-image-caption'
  caption.textContent = turn.caption
  article.append(open, caption)
  return article
}

/**
 * Place image sends, wait cards and finished pictures among Session turns by time.
 * Appending them after the transcript pinned every picture to the bottom.
 */
export function appendLocalConversation(
  root: HTMLElement,
  exchanges: readonly PendingImageExchange[],
  images: readonly GeneratedImageTurn[],
  options: {
    readonly now?: number
    readonly onImageReady?: () => void
    readonly onOpenImage?: (turn: GeneratedImageTurn) => void
    readonly onOpenAttachment?: (image: { readonly url: string; readonly name: string }) => void
  } = {},
): void {
  const now = options.now ?? Date.now()
  const items: { at: number; seq: number; node: HTMLElement }[] = []
  let seq = 0
  for (const exchange of exchanges) {
    items.push({ at: exchange.at, seq: seq++, node: pendingUserNode(exchange, options.onOpenAttachment) })
    if (exchange.phase === 'done' || (exchange.settled && exchange.phase !== 'failed' && exchange.phase !== 'cancelled')) continue
    if (exchange.phase === 'wait' || exchange.phase === 'failed' || exchange.phase === 'cancelled') {
      items.push({ at: Math.max(exchange.at, exchange.waitStartedAt || exchange.at), seq: seq++, node: waitCardNode(exchange, now) })
      continue
    }
    items.push({ at: exchange.at, seq: seq++, node: askCardNode(exchange) })
  }
  for (const turn of images) {
    items.push({
      at: turn.at, seq: seq++,
      node: generatedImageNode(turn, {
        ...(options.onImageReady === undefined ? {} : { onReady: options.onImageReady }),
        ...(options.onOpenImage === undefined ? {} : { onOpen: options.onOpenImage }),
      }),
    })
  }
  items.sort((left, right) => left.at - right.at || left.seq - right.seq)
  for (const item of items) insertByTime(root, item.node, item.at)
}

/** @deprecated Use {@link appendLocalConversation}. Kept for existing tests that only assert wait cards. */
export function appendPendingImageExchanges(
  root: HTMLElement,
  exchanges: readonly PendingImageExchange[],
  options: { readonly busy: boolean; readonly onConfirm: (exchange: PendingImageExchange) => void },
): void {
  void options
  appendLocalConversation(root, exchanges, [])
}

/** Gateway images are local data URIs; they are never parsed from markdown. */
export function appendGeneratedImages(root: HTMLElement, turns: readonly GeneratedImageTurn[]): void {
  appendLocalConversation(root, [], turns)
}
