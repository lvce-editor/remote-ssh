import { strictEqual, rejects } from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { create } from '../src/parts/BackendRouter/BackendRouter.ts'

const opened = (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.onopen = (): void => {
      resolve()
    }
    socket.onerror = (): void => {
      reject(new Error('WebSocket failed'))
    }
  })

void test('switches new sockets while retaining existing authenticated sessions and binary data', async (context) => {
  const controller = new AbortController()
  context.after(() => controller.abort())
  const servers = await Promise.all(
    ['old', 'new'].map(async (name) => {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
      await once(server, 'listening')
      server.on('connection', (socket, request) => {
        strictEqual(
          new URL(request.url!, 'http://localhost').searchParams.get('token'),
          name,
        )
        socket.on('message', (data, binary) =>
          socket.send(
            binary ? data : `${name}:${Buffer.from(data as Buffer).toString()}`,
            { binary },
          ),
        )
      })
      context.after(() => {
        server.close()
      })
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Invalid address')
      return { token: name, url: `ws://127.0.0.1:${address.port}` }
    }),
  )
  const router = await create(servers[0], controller.signal)
  const endpoint = `${router.backend.url}/websocket/terminal-process?token=${router.backend.token}`
  const original = new WebSocket(endpoint)
  await opened(original)
  router.setBackend(servers[1])
  const updated = new WebSocket(endpoint)
  await opened(updated)
  const oldMessage = once(original, 'message')
  original.send('session')
  const [oldEvent] = await oldMessage
  strictEqual(oldEvent.data, 'old:session')
  const newMessage = once(updated, 'message')
  updated.send('session')
  const [newEvent] = await newMessage
  strictEqual(newEvent.data, 'new:session')
  updated.binaryType = 'arraybuffer'
  const binaryMessage = once(updated, 'message')
  updated.send(new Uint8Array([1, 2, 255]))
  const [binaryEvent] = await binaryMessage
  strictEqual(Buffer.from(binaryEvent.data).toString('hex'), '0102ff')
  const closed = Promise.all([once(original, 'close'), once(updated, 'close')])
  controller.abort()
  await closed
  await rejects(opened(new WebSocket(endpoint)))
})

void test('rejects missing tokens and unexpected paths', async (context) => {
  const controller = new AbortController()
  context.after(() => controller.abort())
  const router = await create(
    { token: 'backend-secret', url: 'ws://127.0.0.1:1' },
    controller.signal,
  )
  for (const suffix of [
    '/websocket/terminal-process',
    `/unexpected?token=${router.backend.token}`,
  ]) {
    await rejects(opened(new WebSocket(`${router.backend.url}${suffix}`)))
  }
})
