// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { VideoWorkflowWizard } from '../src/client/VideoWorkflowWizard.tsx'
import { inspectVideoApiGraph, readVideoApiGraphFile, type VideoWorkflowDraftTransport } from '../src/client/video-workflow-authoring.ts'
import { zh } from '../src/client/marketplace-locales.ts'

const graph = {
  '10': { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt: 'test prompt', length: 81, image: ['11', 0] } },
  '11': { class_type: 'LoadImage', inputs: { image: 'owner-image.png' } },
  '12': { class_type: 'VHS_VideoCombine', inputs: { format: 'video/h264-mp4', images: ['10', 0] } },
}
const saved = { id: 'video_draft_123', displayName: '商品短视频', state: 'private-draft' as const,
  graphSha256: 'a'.repeat(64), installable: false as const, dispatchable: false as const }

afterEach(() => { cleanup() })

it('accepts a bounded API graph with one MP4 output and rejects a UI editor export', async () => {
  expect(inspectVideoApiGraph(graph)).toMatchObject({ nodeCount: 3,
    prompts: [{ nodeId: '10', field: 'prompt' }], images: [{ nodeId: '11', field: 'image' }],
    frames: [{ nodeId: '10', field: 'length' }], output: { nodeId: '12' } })
  expect(await readVideoApiGraphFile(new File([JSON.stringify({ nodes: [] })], 'editor.json'))).toBeNull()
  expect(inspectVideoApiGraph({ ...graph, '13': { class_type: 'SaveVideo', inputs: { format: 'mp4' } } })).toBeNull()
})

it('offers H3 prompt, length and nested first-frame mappings while ignoring frame PNG outputs', async () => {
  // Mirrors the reported node roles; it is not the exported Windows graph.
  const h3Graph = { ...graph,
    '10': { class_type: 'MiniMaxH3ImageToVideo', inputs: {
      prompt: 'private prompt', length: 124, first_frame: ['11', 0] } },
    '11': { class_type: 'LoadImage', inputs: { image: 'first_frames/owner/reference.png' } },
    '13': { class_type: 'LayerUtility: PurgeVRAM V2', inputs: { signal: ['10', 0] } },
    '14': { class_type: 'SaveImage', inputs: { images: ['10', 0] } },
    '15': { class_type: 'SaveImage', inputs: { images: ['10', 0] } },
    '16': { class_type: 'SaveImage', inputs: { images: ['10', 0] } },
    '17': { class_type: 'ImageFromBatch', inputs: { image: ['10', 0], batch_index: 119, length: 1 } },
  }
  const result = await readVideoApiGraphFile(new File([JSON.stringify(h3Graph)], 'h3-api.json'))
  expect(result).toMatchObject({ nodeCount: 8,
    prompts: [{ nodeId: '10', field: 'prompt' }],
    images: [{ nodeId: '11', field: 'image' }],
    frames: [{ nodeId: '10', field: 'length' }],
    output: { nodeId: '12', classType: 'VHS_VideoCombine' } })
})

it('guides image-to-video authoring and only reports a private draft after the Host receipt', async () => {
  let resolveSave!: (value: typeof saved) => void
  const save = vi.fn(() => new Promise<typeof saved>((resolve) => { resolveSave = resolve }))
  const transport: VideoWorkflowDraftTransport = { save, list: vi.fn(async () => []) }
  render(<VideoWorkflowWizard t={key => zh[key]} transport={transport} close={vi.fn()} />)
  expect(screen.getByText(zh.videoDraftSourceHelp)).toBeDefined()
  expect(screen.queryByText(zh.videoDraftSaved.replace('{name}', saved.displayName))).toBeNull()
  fireEvent.change(screen.getByLabelText(zh.videoDraftName), { target: { value: saved.displayName } })
  fireEvent.change(screen.getByLabelText(zh.videoDraftFile), {
    target: { files: [new File([JSON.stringify(graph)], 'h3-workflow.json', { type: 'application/json' })] },
  })
  await waitFor(() => { expect(screen.getByText(zh.videoDraftReadSuccess.replace('{count}', '3'))).toBeDefined() })
  fireEvent.click(screen.getByRole('button', { name: zh.videoDraftSave }))
  expect(save).toHaveBeenCalledExactlyOnceWith({ displayName: saved.displayName, template: 'image-to-video',
    graph, mapping: { prompt: { nodeId: '10', field: 'prompt' }, referenceImage: { nodeId: '11', field: 'image' },
      frames: { nodeId: '10', field: 'length' },
      outputNodeId: '12' } })
  expect(screen.queryByText(zh.videoDraftSaved.replace('{name}', saved.displayName))).toBeNull()
  resolveSave(saved)
  await waitFor(() => { expect(screen.getByText(zh.videoDraftSaved.replace('{name}', saved.displayName))).toBeDefined() })
  expect(screen.getByText(zh.videoDraftNext)).toBeDefined()
  expect(screen.getByText(zh.videoDraftPrivate)).toBeDefined()
})

it('auto-selects a text form for a graph without an image but prevents a mismatched image form', async () => {
  const save = vi.fn()
  const transport: VideoWorkflowDraftTransport = { save, list: vi.fn(async () => []) }
  render(<VideoWorkflowWizard t={key => zh[key]} transport={transport} close={vi.fn()} />)
  fireEvent.change(screen.getByLabelText(zh.videoDraftName), { target: { value: saved.displayName } })
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: zh.videoDraftSave })
  expect(submit.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText(zh.videoDraftFile), {
    target: { files: [new File([JSON.stringify({ ...graph, '11': { class_type: 'LoadImage', inputs: {} } })], 'no-image.json')] },
  })
  await waitFor(() => { expect(screen.getByText(zh.videoDraftReadSuccess.replace('{count}', '3'))).toBeDefined() })
  expect(screen.getByText(zh.videoDraftDetectedInputs.replace('{image}', zh.videoDraftNoImageInput)
    .replace('{frames}', zh.videoDraftFramesDetected))).toBeDefined()
  expect(submit.disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(zh.videoDraftImageTemplate) }))
  expect(screen.getByRole('alert').textContent).toBe(zh.videoDraftImageMissing)
  expect(submit.disabled).toBe(true)
  expect(save).not.toHaveBeenCalled()
})

it('prevents text-only publication design from hiding a graph image dependency', async () => {
  const save = vi.fn()
  const transport: VideoWorkflowDraftTransport = { save, list: vi.fn(async () => []) }
  render(<VideoWorkflowWizard t={key => zh[key]} transport={transport} close={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(zh.videoDraftTextTemplate) }))
  fireEvent.change(screen.getByLabelText(zh.videoDraftName), { target: { value: saved.displayName } })
  fireEvent.change(screen.getByLabelText(zh.videoDraftFile), {
    target: { files: [new File([JSON.stringify(graph)], 'h3-workflow.json')] },
  })
  await waitFor(() => { expect(screen.getByText(zh.videoDraftReadSuccess.replace('{count}', '3'))).toBeDefined() })
  expect(screen.getByText(zh.videoDraftTextImageConflict)).toBeDefined()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.videoDraftSave }).disabled).toBe(true)
  expect(save).not.toHaveBeenCalled()
})
