import { defineConfig } from 'tsdown'

/** The independent browser page never loads the owner application's Remote modules. */
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? {
  entry: { viewer: 'lib/types/viewer/index.js' },
  platform: 'browser', target: 'es2024', format: ['esm'], outDir: 'lib',
  clean: false, dts: false, plugins: [], fixedExtension: false,
} : {
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
