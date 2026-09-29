/** Signed source inventory accepted by the buyer before an archive is downloaded. */
import { CatalogFailure } from './registry.ts'

export const LEGACY_INVENTORY_ALGORITHM = 'qianshou.bar-chart-package.v4'
export const SOURCE_INVENTORY_ALGORITHM = 'qianshou.source-package.v1'
/** Fixed native runtime bindings contain metadata only, never user-supplied executable code. */
export const NATIVE_BINDING_INVENTORY_ALGORITHM = 'qianshou.native-binding-package.v1'
export const NATIVE_BINDING_FILES = ['local-adapter.json', 'package.json', 'pnpm-lock.yaml', 'task-definition.json'] as const
/** Reviewed Comfy video is metadata only and has a distinct, non-QuickJS ABI. */
export const COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM = 'qianshou.comfy-video-binding-package.v1'
export const COMFY_VIDEO_BINDING_FILES = NATIVE_BINDING_FILES
/** V5 packages run without third-party dependencies or package install scripts. */
export const EMPTY_ORDER_SOURCE_LOCK = "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: false\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n"

const LEGACY_FILES = ['package.json', 'pnpm-lock.yaml', 'local-adapter.json',
  'src/adapter.mjs', 'src/assemble_gif.py', 'src/encode_frames.swift'] as const
const REQUIRED_SOURCE_FILES = ['package.json', 'pnpm-lock.yaml', 'local-adapter.json'] as const
const SOURCE_ENTRIES = ['src/adapter.mjs', 'src/adapter.quickjs.js'] as const
const HASH = /^[0-9a-f]{64}$/u
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/u

export interface OrderSourceFile {
  path: string
  sizeBytes: number
  sha256: string
}

function invalid(): never { throw new CatalogFailure('order-install-manifest-invalid') }

/** Accept only relative, portable regular-file names without aliases or traversal. */
export function validSourcePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length < 1 || path.length > 200
    || path === 'source-stage.json' || Buffer.byteLength(path, 'utf8') !== path.length) return false
  const parts = path.split('/')
  return parts.length <= 8 && parts.every(part => part !== '.' && part !== '..' && SEGMENT.test(part))
}

/** Validate the signed file set before using names in ZIP or filesystem operations. */
export function validateOrderSourceInventory(algorithm: unknown,
  files: readonly OrderSourceFile[]): void {
  if (![LEGACY_INVENTORY_ALGORITHM, SOURCE_INVENTORY_ALGORITHM, NATIVE_BINDING_INVENTORY_ALGORITHM,
    COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM].includes(String(algorithm))) invalid()
  if (!Array.isArray(files)) invalid()
  if (algorithm === NATIVE_BINDING_INVENTORY_ALGORITHM && files.length !== NATIVE_BINDING_FILES.length) invalid()
  if (algorithm === COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM && files.length !== COMFY_VIDEO_BINDING_FILES.length) invalid()
  if (algorithm === LEGACY_INVENTORY_ALGORITHM && files.length !== LEGACY_FILES.length) invalid()
  if (algorithm === SOURCE_INVENTORY_ALGORITHM && (files.length < 4 || files.length > 128)) invalid()
  let previous = ''
  let total = 0
  const paths = new Set<string>()
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    if (!file || !validSourcePath(file.path)
      || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 || file.sizeBytes > 2_000_000
      || typeof file.sha256 !== 'string' || !HASH.test(file.sha256)) invalid()
    if (algorithm === LEGACY_INVENTORY_ALGORITHM && file.path !== LEGACY_FILES[index]) invalid()
    if (algorithm === NATIVE_BINDING_INVENTORY_ALGORITHM && (file.path !== NATIVE_BINDING_FILES[index]
      || file.sizeBytes > 8192)) invalid()
    if (algorithm === COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM && (file.path !== COMFY_VIDEO_BINDING_FILES[index]
      || file.sizeBytes > 8192)) invalid()
    if (algorithm === SOURCE_INVENTORY_ALGORITHM && index > 0 && file.path <= previous) invalid()
    previous = file.path
    paths.add(file.path)
    total += file.sizeBytes
  }
  if (total > 16 * 1024 * 1024) invalid()
  if (algorithm === SOURCE_INVENTORY_ALGORITHM
    && (REQUIRED_SOURCE_FILES.some(name => !paths.has(name))
      || SOURCE_ENTRIES.filter(name => paths.has(name)).length !== 1)) invalid()
  for (const name of paths) {
    const segments = name.split('/')
    for (let i = 1; i < segments.length; i += 1) {
      if (paths.has(segments.slice(0, i).join('/'))) invalid()
    }
  }
}
