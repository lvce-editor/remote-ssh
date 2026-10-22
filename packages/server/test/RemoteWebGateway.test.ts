import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import { once } from 'node:events'
import { request } from 'node:http'
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
      'x-lvce-protocol': '1',
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
    '/auth/websocket-ticket?process=file-system-process',
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

const fixture = async (
  context: import('node:test').TestContext,
  lifetime?: number,
) => {
  const backend = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(backend, 'listening')
  const address = backend.address()
  if (!address || typeof address === 'string')
    throw new Error('No backend port')
  const requests: string[] = []
  backend.on('connection', (socket, request) => {
    requests.push(request.url || '')
    socket.on('message', (data) => socket.send(data))
  })
  const gateway = await createRemoteWebGateway({
    allowedOrigin,
    backendPort: address.port,
    backendToken: 'backend-secret',
    port: 0,
    publicUrl: 'https://remote.example.com',
    workspacePath: '/tmp/project',
    sessionTtl: lifetime,
  })
  context.after(async () => {
    await gateway.close()
    for (const client of backend.clients) client.terminate()
    await new Promise<void>((resolve) => backend.close(() => resolve()))
  })
  const pair = async (url = gateway.pairingUrl): Promise<string> => {
    const token =
      new URLSearchParams(new URL(url).hash.slice(1)).get('token') || ''
    const response = await post(gateway.localPort, '/auth/pair', token)
    strictEqual(response.status, 200)
    const value = (await response.json()) as {
      protocolVersion: number
      sessionToken: string
      capabilities: string[]
    }
    strictEqual(value.protocolVersion, 1)
    strictEqual(value.capabilities.includes('extension-node-process'), true)
    return value.sessionToken
  }
  const ticket = async (session: string, process: string): Promise<string> => {
    const response = await post(
      gateway.localPort,
      `/auth/websocket-ticket?process=${process}`,
      session,
    )
    strictEqual(response.status, 200)
    return ((await response.json()) as { ticket: string }).ticket
  }
  const socketUrl = (type: string, ticket: string): string =>
    `ws://127.0.0.1:${gateway.localPort}/websocket/${type}?ticket=${ticket}`
  return { gateway, pair, requests, socketUrl, ticket }
}

void test('binds tickets to process and extension identity and forwards only approved parameters', async (context) => {
  const f = await fixture(context)
  const session = await f.pair()
  const wrongProcess = await f.ticket(session, 'file-system-process')
  strictEqual(
    await expectRejectedWebSocket(
      f.socketUrl('terminal-process', wrongProcess),
      allowedOrigin,
    ),
    401,
  )
  strictEqual(
    await expectRejectedWebSocket(
      f.socketUrl('file-system-process', wrongProcess),
      allowedOrigin,
    ),
    401,
  )
  const ticket = await f.ticket(
    session,
    'extension-node-process&extensionId=builtin.git&rpcId=git-client',
  )
  const url = new URL(f.socketUrl('extension-node-process', ticket))
  url.searchParams.set('extensionId', 'builtin.git')
  url.searchParams.set('rpcId', 'git-client')
  url.searchParams.set('token', 'must-not-reach-backend')
  const client = new WebSocket(url, { origin: allowedOrigin })
  await once(client, 'open')
  client.send('ready')
  await once(client, 'message')
  strictEqual(
    f.requests[0],
    '/websocket/extension-node-process?extensionId=builtin.git&rpcId=git-client&token=backend-secret',
  )
  client.close()
  const mismatch = await f.ticket(
    session,
    'extension-node-process&extensionId=builtin.git&rpcId=git-client',
  )
  strictEqual(
    await expectRejectedWebSocket(
      `${f.socketUrl('extension-node-process', mismatch)}&extensionId=other&rpcId=git-client`,
      allowedOrigin,
    ),
    401,
  )
})

void test('revokes live sockets and outstanding tickets, and can issue fresh pairing links', async (context) => {
  const f = await fixture(context)
  const session = await f.pair()
  const unused = await f.ticket(session, 'terminal-process')
  const ticket = await f.ticket(session, 'file-system-process')
  const client = new WebSocket(f.socketUrl('file-system-process', ticket), {
    origin: allowedOrigin,
  })
  await once(client, 'open')
  const closed = once(client, 'close')
  strictEqual(
    (await post(f.gateway.localPort, '/auth/revoke', session)).status,
    200,
  )
  await closed
  strictEqual(
    await expectRejectedWebSocket(
      f.socketUrl('terminal-process', unused),
      allowedOrigin,
    ),
    401,
  )
  strictEqual(
    (
      await post(
        f.gateway.localPort,
        '/auth/websocket-ticket?process=terminal-process',
        session,
      )
    ).status,
    401,
  )
  const nextSession = await f.pair(f.gateway.pair())
  f.gateway.revoke()
  strictEqual(
    (
      await post(
        f.gateway.localPort,
        '/auth/websocket-ticket?process=terminal-process',
        nextSession,
      )
    ).status,
    401,
  )
})

void test('expiry closes live sockets without waiting for another HTTP request', async (context) => {
  const f = await fixture(context, 300)
  const session = await f.pair()
  const ticket = await f.ticket(session, 'file-system-process')
  const client = new WebSocket(f.socketUrl('file-system-process', ticket), {
    origin: allowedOrigin,
  })
  await once(client, 'open')
  await once(client, 'close')
  strictEqual(
    (
      await post(
        f.gateway.localPort,
        '/auth/websocket-ticket?process=file-system-process',
        session,
      )
    ).status,
    401,
  )
})

void test('checks protocol before consuming pairing, rejects request bodies, and bounds authentication attempts', async (context) => {
  const f = await fixture(context)
  const invalidProtocol = await fetch(
    `http://127.0.0.1:${f.gateway.localPort}/auth/pair`,
    { headers: { origin: allowedOrigin }, method: 'POST' },
  )
  strictEqual(invalidProtocol.status, 426)
  const session = await f.pair()
  const body = await fetch(
    `http://127.0.0.1:${f.gateway.localPort}/auth/pair`,
    { headers: { origin: allowedOrigin }, method: 'POST', body: 'unexpected' },
  )
  strictEqual(body.status, 413)
  strictEqual(
    (
      await post(
        f.gateway.localPort,
        '/auth/websocket-ticket?process=unknown',
        session,
      )
    ).status,
    400,
  )
  let response: Response | undefined
  for (let i = 0; i < 121; i++)
    response = await post(f.gateway.localPort, '/auth/pair', 'invalid')
  strictEqual(response?.status, 429)
})

void test('malformed HTTP and upgrade URLs cannot crash the gateway', async (context) => {
  const f = await fixture(context)
  for (const upgrade of [false, true]) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const incoming = request(
        {
          hostname: '127.0.0.1',
          port: f.gateway.localPort,
          path: 'http://[',
          method: 'POST',
          headers: {
            origin: allowedOrigin,
            ...(upgrade ? { connection: 'Upgrade', upgrade: 'websocket' } : {}),
          },
        },
        (response) => {
          response.resume()
          resolve(response.statusCode)
        },
      )
      incoming.on('error', reject)
      incoming.end()
    })
    strictEqual(status, 400)
  }
  await f.pair()
})
