import type { Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { createServer, request } from 'node:http'

export interface Backend {
  readonly token: string
  readonly url: string
}

// Existing upgraded sockets retain their backend. Only future upgrades switch;
// terminal IDs, watchers and outstanding writes are never replayed.
export const create = async (
  initial: Backend,
  signal: AbortSignal,
): Promise<{
  readonly backend: Backend
  readonly setBackend: (backend: Backend) => void
}> => {
  signal.throwIfAborted()
  let selected = initial
  const token = randomBytes(32).toString('hex')
  const sockets = new Set<Socket>()
  const server = createServer((_request, response) => {
    response.writeHead(403).end()
  })
  const track = (socket: Socket): void => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
  }
  server.on('connection', track)
  server.on('upgrade', (incoming, socket, head) => {
    const url = new URL(incoming.url || '/', 'http://127.0.0.1')
    if (
      signal.aborted ||
      url.searchParams.get('token') !== token ||
      !/^\/websocket\/[a-z-]+$/.test(url.pathname)
    ) {
      socket.destroy()
      return
    }
    const target = new URL(selected.url)
    url.searchParams.set('token', selected.token)
    const upstream = request({
      headers: { ...incoming.headers, host: target.host },
      hostname: target.hostname,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      port: target.port,
      signal,
      timeout: 10_000,
    })
    socket.once('close', () => upstream.destroy())
    upstream.once('error', () => socket.destroy())
    upstream.once('timeout', () => upstream.destroy())
    upstream.once('response', (response) => {
      response.destroy()
      socket.destroy()
    })
    upstream.once('upgrade', (response, backendSocket, backendHead) => {
      track(backendSocket)
      if (socket.destroyed || signal.aborted) {
        backendSocket.destroy()
        return
      }
      const headers = response.rawHeaders
      let handshake = 'HTTP/1.1 101 Switching Protocols\r\n'
      for (let index = 0; index < headers.length; index += 2) {
        handshake += `${headers[index]}: ${headers[index + 1]}\r\n`
      }
      socket.write(`${handshake}\r\n`)
      if (backendHead.length > 0) socket.write(backendHead)
      if (head.length > 0) backendSocket.write(head)
      socket.once('close', () => backendSocket.destroy())
      backendSocket.once('close', () => socket.destroy())
      socket.pipe(backendSocket).pipe(socket)
    })
    upstream.end()
  })
  const dispose = (): void => {
    server.close()
    for (const socket of sockets) socket.destroy()
  }
  signal.addEventListener('abort', dispose, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    signal.throwIfAborted()
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Router unavailable')
    return {
      backend: { token, url: `ws://127.0.0.1:${address.port}` },
      setBackend: (backend): void => {
        selected = backend
      },
    }
  } catch (error) {
    signal.removeEventListener('abort', dispose)
    dispose()
    throw error
  }
}
