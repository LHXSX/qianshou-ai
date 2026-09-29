import { expect, it, vi } from 'vitest'
import { importMarketAttachments, type MarketAttachmentPorts } from '../src/market-attachment-import.ts'

function fixture() {
  const upload = vi.fn().mockImplementation(async (input: { filename: string }) => ({ filename: input.filename }))
  const ports: MarketAttachmentPorts<{ filename: string }> = {
    resolve: receiptId => receiptId === 'owned-receipt' ? { name: '案卷.pptx', bytes: 3 } : undefined,
    async *read() { yield new Uint8Array([1]); yield new Uint8Array([2, 3]) }, upload,
  }
  return { ports, upload, signal: new AbortController().signal }
}

it('moves an owned composer PPT receipt through the ordinary upload port as exact bytes', async () => {
  const { ports, upload, signal } = fixture()
  expect(await importMarketAttachments([{ type: 'file', receiptId: 'owned-receipt' }], ports, signal))
    .toEqual([{ filename: '案卷.pptx' }])
  expect(upload).toHaveBeenCalledExactlyOnceWith({ filename: '案卷.pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    bytes: new Uint8Array([1, 2, 3]) }, signal)
})

it('rejects a foreign Session receipt before any direct storage write', async () => {
  const { ports, upload, signal } = fixture()
  await expect(importMarketAttachments([{ type: 'file', receiptId: 'another-session' }], ports, signal))
    .rejects.toThrow('COMPUTE_INPUT_RECEIPT_INVALID')
  expect(upload).not.toHaveBeenCalled()
})

it('validates the entire selection and verified stream before any partial upload', async () => {
  const { ports, upload, signal } = fixture()
  await expect(importMarketAttachments([{ type: 'file', receiptId: 'owned-receipt' },
    { type: 'image', mediaType: 'image/png', data: 'malformed!' }], ports, signal))
    .rejects.toThrow('COMPUTE_INPUT_UPLOAD_INVALID')
  ports.read = async function* () { yield new Uint8Array([1, 2]) }
  await expect(importMarketAttachments([{ type: 'file', receiptId: 'owned-receipt' }], ports, signal))
    .rejects.toThrow('COMPUTE_INPUT_SIZE_MISMATCH')
  expect(upload).not.toHaveBeenCalled()
})

it('keeps image bytes at the local upload port and observes cancellation', async () => {
  const { ports, upload } = fixture()
  const abort = new AbortController()
  await importMarketAttachments([{ type: 'image', mediaType: 'image/png', name: '合同.png', data: 'AQID' }], ports, abort.signal)
  expect(upload).toHaveBeenCalledExactlyOnceWith({ filename: '合同.png', contentType: 'image/png',
    bytes: Buffer.from([1, 2, 3]) }, abort.signal)
  upload.mockClear(); abort.abort()
  await expect(importMarketAttachments([{ type: 'file', receiptId: 'owned-receipt' }], ports, abort.signal)).rejects.toThrow()
  expect(upload).not.toHaveBeenCalled()
})

it('bounds count and total selected bytes before reading or uploading', async () => {
  const { ports, upload, signal } = fixture()
  await expect(importMarketAttachments(Array.from({ length: 16 }, () => ({ type: 'file', receiptId: 'owned-receipt' })), ports, signal))
    .rejects.toThrow('COMPUTE_INPUT_UPLOAD_INVALID')
  ports.resolve = () => ({ name: 'huge.pdf', bytes: 16 * 1024 * 1024 + 1 })
  await expect(importMarketAttachments([{ type: 'file', receiptId: 'owned-receipt' }], ports, signal))
    .rejects.toThrow('COMPUTE_INPUT_UPLOAD_INVALID')
  expect(upload).not.toHaveBeenCalled()
})
