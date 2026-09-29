/** Static browser projection only; this server does not launch an Agent runtime. */
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { forwardPreviewHeaders } from './preview-proxy.ts'
const root = fileURLToPath(new URL('.', import.meta.url))
const repo = fileURLToPath(new URL('../..', import.meta.url))
const origin = process.env.QIANSHOU_PREVIEW_ACCOUNT_ORIGIN ?? 'https://qianshousuanli.com'
const url = new URL(origin)
if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
  || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw new Error('PREVIEW_ACCOUNT_ORIGIN_INVALID')
const imageOrigin = process.env.QIANSHOU_PREVIEW_IMAGE_ORIGIN ?? 'https://app.qianshousuanli.com'
const imageUrl = new URL(imageOrigin)
if (imageUrl.username || imageUrl.password || imageUrl.pathname !== '/' || imageUrl.search || imageUrl.hash
  || (imageUrl.protocol !== 'https:' && !(imageUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(imageUrl.hostname)))) throw new Error('PREVIEW_IMAGE_ORIGIN_INVALID')
const agentOrigin = process.env.QIANSHOU_PREVIEW_AGENT_ORIGIN
const agentUrl = agentOrigin === undefined ? undefined : new URL(agentOrigin)
if (agentUrl && (agentUrl.username || agentUrl.password || agentUrl.pathname !== '/' || agentUrl.search || agentUrl.hash
  || (agentUrl.protocol !== 'https:' && !(agentUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(agentUrl.hostname))))) throw new Error('PREVIEW_AGENT_ORIGIN_INVALID')
export default {
  root,
  // This build used to install a `mobile-browser-painter` shim that redirected
  // the native painter at a throwing stub, because the shared window entry
  // imported one. That painter is gone and the entry now takes the browser's
  // own painter, so no shim is needed.
  plugins: [tsconfigPaths({ projects: [`${repo}/tsconfig.base.json`], loose: true })],
  resolve: { alias: [
    { find: /^@deepseek-ai\/dsh-client-pc-window-bridge$/, replacement: `${repo}/packages/client/pc-window-bridge/src/index.ts` },
    { find: /^@deepseek-ai\/dsh-client-compute-trigger$/, replacement: `${repo}/packages/client/compute-trigger/src/index.ts` },
    { find: /^@deepseek-ai\/dsh-client-mobile-agent-shell$/, replacement: `${repo}/packages/client/mobile-agent-shell/src/index.ts` },
  ] },
  define: { __MOBILE_AGENT_HTTP__: agentUrl !== undefined, __ACCOUNT_ORIGIN__: JSON.stringify(url.origin) },
  server: { host: '127.0.0.1', port: 4175, strictPort: true, fs: { allow: [repo] }, proxy: {
    '/api/qianshou/ai/': {
      target: imageUrl.origin, changeOrigin: true, followRedirects: false,
      configure(proxy: {
        on(event: 'proxyReq', listener: (request: { removeHeader: (name: string) => void; setHeader: (name: string, value: string) => void }, incoming: { headers: { host?: string; origin?: string; 'sec-fetch-site'?: string } }) => void): void
        on(event: 'proxyRes', listener: (response: { headers: Record<string, unknown> }) => void): void
      }) {
        proxy.on('proxyReq', (request, incoming) => { forwardPreviewHeaders(request, incoming.headers, imageUrl.origin) })
        proxy.on('proxyRes', response => { delete response.headers['set-cookie'] })
      },
    },
    ...(agentUrl === undefined ? {} : { '/api/qianshou/mobile-agent/v1/': { target: agentUrl.origin, changeOrigin: true, followRedirects: false } }),
    '/account-api': { target: url.origin, changeOrigin: true, rewrite: (path: string) => path.replace(/^\/account-api/, ''),
      configure(proxy: {
        on(event: 'proxyReq', listener: (request: { removeHeader: (name: string) => void }) => void): void
        on(event: 'proxyRes', listener: (response: { headers: Record<string, unknown> }) => void): void
      }) {
        proxy.on('proxyReq', request => { request.removeHeader('cookie') })
        proxy.on('proxyRes', response => { delete response.headers['set-cookie'] })
      },
    },
  } },
  build: { outDir: 'dist', emptyOutDir: true },
}
