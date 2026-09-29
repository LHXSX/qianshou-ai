/**
 * Python packages this node may advertise, keyed by platform `required_software` names.
 *
 * Binaries stay in {@link HOST_SUPPLY_TOOLS}. This list is the second half of the same
 * unique source: hello `software` may grow when an import succeeds, and must not grow from
 * a handwritten daemon array (that copy used `PIL` / `pandas`, which the planner never asks for).
 *
 * The four non-Python members of the platform's 14 (`blender`, `ffmpeg`, `local_llm`,
 * `moondream2`) are not here. `ffmpeg` is already a binary catalogue row; the others have no
 * honest import probe on this host.
 */
export interface HostSupplyPackageSpec {
  /** Advertised token; must match `task_registry.required_software` spelling. */
  readonly id: string
  /** Owner-visible name. */
  readonly name: string
  /** `importlib.import_module` argument; may differ from `id` (`pillow` → `PIL`). */
  readonly module: string
}

/**
 * Every Python member of the platform's 14 `required_software` names.
 * Order is stable so tests can pin the ids without sorting.
 */
export const HOST_SUPPLY_PACKAGES: readonly HostSupplyPackageSpec[] = Object.freeze([
  Object.freeze({ id: 'faster_whisper', name: 'faster-whisper', module: 'faster_whisper' }),
  Object.freeze({ id: 'numpy', name: 'NumPy', module: 'numpy' }),
  Object.freeze({ id: 'onnxruntime', name: 'ONNX Runtime', module: 'onnxruntime' }),
  Object.freeze({ id: 'openpyxl', name: 'openpyxl', module: 'openpyxl' }),
  Object.freeze({ id: 'pillow', name: 'Pillow', module: 'PIL' }),
  Object.freeze({ id: 'pymupdf', name: 'PyMuPDF', module: 'fitz' }),
  Object.freeze({ id: 'readability', name: 'readability', module: 'readability' }),
  Object.freeze({ id: 'requests', name: 'requests', module: 'requests' }),
  Object.freeze({ id: 'selectolax', name: 'selectolax', module: 'selectolax' }),
  Object.freeze({ id: 'whisper', name: 'whisper', module: 'whisper' }),
])
