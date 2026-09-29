/** Research-only source-mode integration fixture: real Guangzhou HTTP/SQLite runs in its own compiler context. */
import { createServer } from 'node:http'
import { join } from 'node:path'
import { once } from 'node:events'

const { MediaNodeStore } = await import(new URL('../../../../../../guangzhou/packages/host/model-gateway/src/media-node-store.ts', import.meta.url).href)
const { createMediaNodeRoutes } = await import(new URL('../../../../../../guangzhou/packages/host/model-gateway/src/media-node-http.ts', import.meta.url).href)
const store = new MediaNodeStore({ path: join(process.env.MEDIA_NODE_TEST_ROOT, 'gateway.sqlite'), heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 5000 })
const routes = createMediaNodeRoutes({ store,
  verifyAccount: async request => request.headers.get('authorization') === 'Bearer owner-access-token-fixture'
    ? { accountId: '21', role: 'personal', isAdmin: false } : null,
  dispatchToken: async () => 's'.repeat(32), maxLongPollRequests: 8 })
const paths = []
let failChannel = 0
let failDisconnect = 0
let dropClaim = 0
let dropUpload = 0
let dropEvent = 0
const server = createServer((request, response) => {
  paths.push(request.url ?? '')
  if (request.url === '/v1/nodes/channel' && failChannel > 0) { failChannel--; response.writeHead(503).end(); return }
  if (request.url === '/v1/nodes/disconnect' && failDisconnect > 0) { failDisconnect--; response.writeHead(503).end(); return }
  const dropped = request.url === '/v1/nodes/research/claim' && dropClaim > 0
    || request.url === '/v1/nodes/research/results/upload' && dropUpload > 0
    || request.url === '/v1/nodes/research/events' && dropEvent > 0
  if (dropped) {
    if (request.url.endsWith('/claim')) dropClaim--
    else if (request.url.endsWith('/upload')) dropUpload--
    else dropEvent--
    response.end = function () { this.destroy(); return this }
  }
  const route = routes.routes.find(item => item.path === request.url)
  if (route === undefined) { response.writeHead(404).end(); return }
  void route.handler(request, response)
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const address = server.address()
process.send({ ready: true, origin: `http://127.0.0.1:${address.port}` })
process.on('message', async message => {
  try {
    let result
    if (message.method === 'directory') result = store.directory()
    else if (message.method === 'researchDirectory') result = store.researchDirectory('21')
    else if (message.method === 'adminList') result = store.adminList('21')
    else if (message.method === 'failChannelOnce') { failChannel = 1; result = true }
    else if (message.method === 'failDisconnectOnce') { failDisconnect = 1; result = true }
    else if (message.method === 'paths') result = paths
    else if (message.method === 'researchDispatch') result = store.researchDispatch(message.value)
    else if (message.method === 'researchTask') result = store.researchTaskStatus(message.value.taskId, message.value.attemptId)
    else if (message.method === 'dropClaim') { dropClaim = 1; result = true }
    else if (message.method === 'dropUpload') { dropUpload = 1; result = true }
    else if (message.method === 'dropEvent') { dropEvent = 1; result = true }
    else if (message.method === 'dispatch') result = store.dispatch(message.value)
    else if (message.method === 'close') {
      server.closeAllConnections(); await routes.close(); await new Promise(resolve => server.close(resolve))
      process.send({ id: message.id, result: true }); process.disconnect(); return
    } else throw new Error('fixture operation invalid')
    process.send({ id: message.id, result })
  } catch (error) { process.send({ id: message.id, error: error.code ?? error.message }) }
})
