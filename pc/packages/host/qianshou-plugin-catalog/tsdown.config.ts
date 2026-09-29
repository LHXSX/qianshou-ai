import { defineConfig } from 'tsdown'

/** Host-only discovery inherits generated Remote artifacts from the workspace build. */
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [] : {
  entry: ['lib/types/index.js', 'lib/types/official-seed-csv-tools.js',
    'lib/types/reviewed-seed-market-tools.js', 'lib/types/local-skill-tools.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
