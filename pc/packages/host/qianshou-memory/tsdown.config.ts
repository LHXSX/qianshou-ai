import { defineConfig } from 'tsdown'

/** Add the optional tool consumer while inheriting the workspace's Host Typert plugin and output policy. */
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [] : {
  entry: ['lib/types/{index,tools}.js'],
})
