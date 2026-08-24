import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { createRemoteWebGateway } from '../src/RemoteWebGateway.ts'

const allowedOrigin = 'https://lvce-editor.github.io'

const post = async (
  port: number,
  path: string,
  token: string,
  origin = allowedOrigin,
): Promise<Response> => {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      origin,
    },
    method: 'POST',
  })
}

const expectRejectedWebSocket = async (
  url: string,
  origin: string,
): Promise<number> => {
  const webSocket = new WebSocket(url, { origin })
  webSocket.on('error', () => {})
  const [, response] = (await once(
    webSocket,
    'unexpected-response',
  )) as unknown as readonly [unknown, { readonly statusCode: number }]
  return response.statusCode
}

void test('rejects insecure public origins before opening a gateway', async () => {
  await rejects(
    createRemoteWebGateway({
      allowedOrigin: 'http://editor.example.com',
      backendPort: 1,
      backendToken: 'unused',
      port: 0,
      publicUrl: 'https://remote.example.com',
      workspacePath: '/home/test/project',
    }),
    /--allowed-origin must use https/,
  )
  await rejects(
    createRemoteWebGateway({
      allowedOrigin,
      backendPort: 1,
      backendToken: 'unused',
      port: 0,
      publicUrl: 'http://remote.example.com',
      workspacePath: '/home/test/project',
    }),
    /--public-url must use https/,
  )
})

void test('pairs once and proxies an origin-authenticated ticket', async (context) => {
  const backend = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(backend, 'listening')
  context.after(() => backend.close())
  const backendAddress = backend.address()
  if (!backendAddress || typeof backendAddress === 'string') {
    throw new Error('Expected a TCP backend address')
  }
  let backendRequestUrl = ''
  backend.on('connection', (webSocket, request) => {
    backendRequestUrl = request.url || ''
    webSocket.on('message', (message) => webSocket.send(message))
  })

  const gateway = await createRemoteWebGateway({
    allowedOrigin,
    backendPort: backendAddress.port,
    backendToken: 'internal-backend-secret',
    port: 0,
    publicUrl: 'https://remote.example.com',
    workspacePath: '/home/test/project',
  })
  context.after(() => gateway.close())
  const pairingToken = new URL(gateway.pairingUrl).hash.slice('#token='.length)

  strictEqual(
    (
      await post(
        gateway.localPort,
        '/auth/pair',
        pairingToken,
        'https://evil.example.com',
      )
    ).status,
    403,
  )
  const pairingResponse = await post(
    gateway.localPort,
    '/auth/pair',
    pairingToken,
  )
  strictEqual(pairingResponse.status, 200)
  const pairing = (await pairingResponse.json()) as {
    readonly authentication: string
    readonly sessionToken: string
    readonly websocketUrl: string
    readonly workspacePath: string
  }
  deepStrictEqual(
    {
      authentication: pairing.authentication,
      websocketUrl: pairing.websocketUrl,
      workspacePath: pairing.workspacePath,
    },
    {
      authentication: 'websocket-ticket',
      websocketUrl: 'wss://remote.example.com/',
      workspacePath: '/home/test/project',
    },
  )
  strictEqual(
    (await post(gateway.localPort, '/auth/pair', pairingToken)).status,
    401,
  )

  const ticketResponse = await post(
    gateway.localPort,
    '/auth/websocket-ticket',
    pairing.sessionToken,
  )
  strictEqual(ticketResponse.status, 200)
  const { ticket } = (await ticketResponse.json()) as {
    readonly ticket: string
  }
  const socketUrl = `ws://127.0.0.1:${gateway.localPort}/websocket/file-system-process?ticket=${ticket}`
  strictEqual(
    await expectRejectedWebSocket(socketUrl, 'https://evil.example.com'),
    403,
  )

  const webSocket = new WebSocket(socketUrl, { origin: allowedOrigin })
  await once(webSocket, 'open')
  context.after(() => webSocket.close())
  webSocket.send('hello')
  const [message] = (await once(webSocket, 'message')) as unknown as readonly [
    Buffer,
  ]
  strictEqual(message.toString(), 'hello')
  strictEqual(
    backendRequestUrl,
    '/websocket/file-system-process?token=internal-backend-secret',
  )
  strictEqual(await expectRejectedWebSocket(socketUrl, allowedOrigin), 401)
})
