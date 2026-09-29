/** Loopback relay ingress accepts only the existing native device WebSocket. */
import { createServer, request as httpRequest } from 'node:http'

/** Forward an exact device upgrade to the already-owned local backend. */
export async function startDeviceGateway(backendPort) {
  if (!Number.isInteger(backendPort) || backendPort < 1024 || backendPort > 65535) throw new Error('INVALID_BACKEND_PORT')
  const sockets = new Set(), pending = new Set()
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/qianshou-device' ? 426 : 404, { Connection: 'close' }).end()
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => { socket.destroy() }) }
  server.on('connection', track)
  server.on('upgrade', (request, client, head) => {
    if (request.method !== 'GET' || request.url !== '/qianshou-device' || request.headers.origin !== undefined
      || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    const headers = { Connection: 'Upgrade', Upgrade: 'websocket' }
    for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
      if (request.headers[name] !== undefined) headers[name] = request.headers[name]
    }
    const upstream = httpRequest({ host: '127.0.0.1', port: backendPort, path: '/qianshou-device', method: 'GET', headers, timeout: 5000 })
    pending.add(upstream)
    upstream.once('close', () => pending.delete(upstream))
    const abort = () => { upstream.destroy() }
    client.once('close', abort)
    upstream.on('timeout', () => { upstream.destroy() })
    upstream.on('error', () => { client.destroy() })
    upstream.on('response', response => {
      client.end(`HTTP/1.1 ${response.statusCode === 403 ? 403 : 502} Rejected\r\nConnection: close\r\n\r\n`)
      response.destroy()
    })
    upstream.on('upgrade', (response, remote, remoteHead) => {
      track(remote)
      client.removeListener('close', abort)
      if (client.destroyed || response.statusCode !== 101) { remote.destroy(); client.destroy(); return }
      const allowed = ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']
      const responseHeaders = allowed.flatMap(name => typeof response.headers[name] === 'string' ? [`${name}: ${response.headers[name]}`] : [])
      client.write('HTTP/1.1 101 Switching Protocols\r\n' + responseHeaders.join('\r\n') + '\r\n\r\n')
      if (remoteHead.length) client.write(remoteHead)
      if (head.length) remote.write(head)
      client.once('close', () => remote.destroy())
      remote.once('close', () => client.destroy())
      client.pipe(remote); remote.pipe(client)
    })
    upstream.end()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  return {
    port,
    async close() {
      for (const request of pending) request.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
    },
  }
}
