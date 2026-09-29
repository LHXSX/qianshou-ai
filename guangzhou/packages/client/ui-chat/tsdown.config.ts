import { clientBundle } from '../tsdown.client.ts'
import type { UserConfig } from 'tsdown'

const bundle = clientBundle('@deepseek-ai/dsh-client-ui-chat', ['lib/types/index.js'])

// Browser plugins are registered factories, not URL-addressable CommonJS
// modules. Keep the deferred WebGL runtime in this factory so local require
// chunks cannot escape the module table. GPU/model creation remains lazy.
export default (options: Parameters<typeof bundle>[0]): UserConfig[] => bundle(options).map(config =>
  config.name?.endsWith('/client') === true
    ? { ...config, outputOptions: { ...config.outputOptions, codeSplitting: false } }
    : config,
)
