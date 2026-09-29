// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { planImageIntent } from '@deepseek-ai/dsh-client-compute-trigger'
import { appendLocalConversation, renderMessageMarkdown, type GeneratedImageTurn, type PendingImageExchange } from '../src/components/message-view.ts'

function exchange(id: string, at: number, phase: PendingImageExchange['phase'] = 'done'): PendingImageExchange {
  const ready = planImageIntent('出个小狗图')
  if (ready === null) throw new Error('TEST_PLAN')
  return {
    id, text: `出图 ${id}`, plan: ready, at, attachments: [],
    phase, settled: phase === 'done', waitMessage: '', waitStartedAt: at,
  }
}

describe('conversation layout', () => {
  it('places a finished picture before a later Session turn so new chat lifts the image', () => {
    const root = document.createElement('div')
    const later = document.createElement('article')
    later.dataset.testid = 'mobile-turn-later'
    later.dataset.at = '200'
    later.textContent = 'later chat'
    root.append(later)
    const image: GeneratedImageTurn = {
      id: 'pic-1', prompt: '小狗', dataUri: 'data:image/jpeg;base64,QQ==', mimeType: 'image/jpeg', at: 50, caption: '图片已生成。',
    }
    appendLocalConversation(root, [exchange('1', 40)], [image])
    const order = [...root.children].map(node => (node as HTMLElement).dataset.testid)
    expect(order).toEqual(['pending-image-user-1', 'generated-image-pic-1', 'mobile-turn-later'])
  })

  it('renders bold, paragraphs and tables without dumping raw markup', () => {
    const tree = renderMessageMarkdown('第一段。\n\n**加粗** 和 🙂\n\n| 列 | 值 |\n| --- | --- |\n| A | 1 |')
    expect(tree.querySelectorAll('p').length).toBeGreaterThanOrEqual(2)
    expect(tree.querySelector('strong')?.textContent).toBe('加粗')
    expect(tree.querySelector('.message-table table')).not.toBeNull()
    expect(tree.querySelector('th')?.textContent).toBe('列')
    expect(tree.innerHTML).not.toContain('**加粗**')
    expect(tree.textContent).toContain('🙂')
  })

  it('reports elapsed waiting without inventing a generation percentage', () => {
    const root = document.createElement('div')
    appendLocalConversation(root, [{ ...exchange('wait', 0, 'wait'), waitMessage: '正在出图，请稍等。' }], [], { now: 1_200 })
    expect(root.querySelector('.image-wait-percent')?.textContent).toBe('已等待 1 秒')
    expect(root.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false)
  })

  it('keeps a terminal image failure visible without asking for more image details', () => {
    const root = document.createElement('div')
    appendLocalConversation(root, [{ ...exchange('failed', 0, 'failed'), settled: true, waitMessage: '图片服务暂时不可用' }], [])
    expect(root.textContent).toContain('图片服务暂时不可用')
    expect(root.querySelector('.image-wait-card-failed')).not.toBeNull()
    expect(root.querySelector('.image-intent-card')).toBeNull()
  })

  it('opens a finished picture through a dedicated button', () => {
    const root = document.createElement('div')
    const opened: string[] = []
    const image: GeneratedImageTurn = {
      id: 'pic-1', prompt: '小狗', dataUri: 'data:image/jpeg;base64,QQ==', mimeType: 'image/jpeg', at: 50, caption: '图片已生成。',
    }
    appendLocalConversation(root, [], [image], { onOpenImage: (turn) => { opened.push(turn.id) } })
    root.querySelector<HTMLButtonElement>('[data-testid="generated-image-open-pic-1"]')!.click()
    expect(opened).toEqual(['pic-1'])
  })
})
