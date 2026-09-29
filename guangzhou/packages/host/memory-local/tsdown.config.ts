import { defineConfig } from 'tsdown'

const entry = (path: string) => ({
  entry: [path],
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024' as const,
  fixedExtension: false,
  dts: false,
  clean: false,
})

/** Keep both exported entries self-contained within the package's files list. */
export default defineConfig([
  entry('lib/types/index.js'),
  entry('lib/types/tools.js'),
])
