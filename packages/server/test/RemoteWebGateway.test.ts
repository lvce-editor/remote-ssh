import {
  deepStrictEqual,
  rejects,
  strictEqual,
  throws,
} from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
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
    webSocket.send(JSON.stringify('ready'))
    webSocket.send(Buffer.from(JSON.stringify('ready')))
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
  const pairingToken = new URL(gateway.pairingUrl!).hash.slice('#token='.length)

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
  accountAccess?: {
    readonly key: string
    readonly check: () => Promise<boolean>
  },
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
    accountAccess,
    accountCheckInterval: 20,
  })
  context.after(async () => {
    await gateway.close()
    for (const client of backend.clients) client.terminate()
    await new Promise<void>((resolve) => backend.close(() => resolve()))
  })
  const pair = async (url = gateway.pairingUrl || ''): Promise<string> => {
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

void test('expired pairing secrets and expired tickets cannot authorize a connection', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const f = await fixture(context)
  const token = new URLSearchParams(
    new URL(f.gateway.pairingUrl!).hash.slice(1),
  ).get('token')!
  context.mock.timers.tick(10 * 60 * 1000 + 1)
  strictEqual(
    (await post(f.gateway.localPort, '/auth/pair', token)).status,
    401,
  )
  const session = await f.pair(f.gateway.pair())
  const expired = await f.ticket(session, 'file-system-process')
  context.mock.timers.tick(60_001)
  strictEqual(
    await expectRejectedWebSocket(
      f.socketUrl('file-system-process', expired),
      allowedOrigin,
    ),
    401,
  )
  const fresh = await f.ticket(session, 'file-system-process')
  const client = new WebSocket(f.socketUrl('file-system-process', fresh), {
    origin: allowedOrigin,
  })
  context.after(() => client.terminate())
  await once(client, 'open')
})

void test('forwards a file-sized payload larger than one MiB within the gateway limits', async (context) => {
  const f = await fixture(context)
  const session = await f.pair()
  const ticket = await f.ticket(session, 'file-system-process')
  const client = new WebSocket(f.socketUrl('file-system-process', ticket), {
    origin: allowedOrigin,
  })
  context.after(() => client.terminate())
  await once(client, 'open')
  const payload = Buffer.alloc(1280 * 1024, 'a')
  const reply = once(client, 'message')
  client.send(payload)
  const [data] = await reply
  strictEqual(Buffer.compare(data as Buffer, payload), 0)
})

void test('pairing another browser preserves the first browser session', async (context) => {
  const f = await fixture(context)
  const first = await f.pair()
  const second = await f.pair(f.gateway.pair())
  await f.ticket(first, 'file-system-process')
  await f.ticket(second, 'file-system-process')
})

const grant = (key: string, fields: object = {}): string => {
  const payload = Buffer.from(
    JSON.stringify({
      audience: 'https://remote.example.com',
      origin: allowedOrigin,
      expiresAt: Date.now() + 60_000,
      nonce: randomBytes(32).toString('base64url'),
      ...fields,
    }),
  ).toString('base64url')
  return `${payload}.${createHmac('sha256', Buffer.from(key, 'hex')).update(`lvce-browser-access-v1.${payload}`).digest('base64url')}`
}
void test('account grants create independent browser sessions, reject replay and revoke only the signing-out browser', async (context) => {
  const key = '34'.repeat(32)
  const f = await fixture(context, undefined, { key, check: async () => true })
  const firstGrant = grant(key)
  const first = await post(f.gateway.localPort, '/auth/account', firstGrant)
  strictEqual(first.status, 200)
  const firstValue = (await first.json()) as {
    sessionExpiresAt: string | null
    sessionToken: string
  }
  strictEqual(firstValue.sessionExpiresAt, null)
  const firstSession = firstValue.sessionToken
  strictEqual(
    (await post(f.gateway.localPort, '/auth/account', firstGrant)).status,
    401,
  )
  const second = await post(f.gateway.localPort, '/auth/account', grant(key))
  strictEqual(second.status, 200)
  const secondSession = ((await second.json()) as { sessionToken: string })
    .sessionToken
  await f.ticket(firstSession, 'file-system-process')
  await f.ticket(secondSession, 'file-system-process')
  strictEqual(
    (await post(f.gateway.localPort, '/auth/revoke', firstSession)).status,
    200,
  )
  strictEqual(
    (await post(f.gateway.localPort, '/auth/session', firstSession)).status,
    401,
  )
  await f.ticket(secondSession, 'file-system-process')
  for (const invalid of [
    grant('56'.repeat(32)),
    grant(key, { audience: 'https://other.example' }),
    grant(key, { origin: 'https://evil.test' }),
    grant(key, { expiresAt: Date.now() - 1 }),
    grant(key, { expiresAt: Date.now() + 120_000 }),
    'malformed',
  ])
    strictEqual(
      (await post(f.gateway.localPort, '/auth/account', invalid)).status,
      401,
    )
  strictEqual(
    (
      await post(
        f.gateway.localPort,
        '/auth/account',
        grant(key),
        'https://evil.test',
      )
    ).status,
    403,
  )
})
void test('managed account sessions last beyond 24 hours until tunnel access is revoked', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const key = '34'.repeat(32)
  const f = await fixture(context, 300, { key, check: async () => true })
  const response = await post(f.gateway.localPort, '/auth/account', grant(key))
  const session = ((await response.json()) as { sessionToken: string })
    .sessionToken
  context.mock.timers.tick(24 * 60 * 60 * 1000 + 1)
  strictEqual(
    (await post(f.gateway.localPort, '/auth/session', session)).status,
    200,
  )
  await f.ticket(session, 'file-system-process')
})
void test('failed account ownership checks close account sockets, reject access, then recover without allowing manual pairing', async (context) => {
  const key = '34'.repeat(32)
  let permitted = true
  const f = await fixture(context, undefined, {
    key,
    check: async () => permitted,
  })
  const response = await post(f.gateway.localPort, '/auth/account', grant(key))
  const session = ((await response.json()) as { sessionToken: string })
    .sessionToken
  const ticket = await f.ticket(session, 'file-system-process')
  const socket = new WebSocket(f.socketUrl('file-system-process', ticket), {
    origin: allowedOrigin,
  })
  await once(socket, 'open')
  const disconnected = once(socket, 'close')
  permitted = false
  await disconnected
  strictEqual(
    (await post(f.gateway.localPort, '/auth/session', session)).status,
    401,
  )
  strictEqual(
    (await post(f.gateway.localPort, '/auth/account', grant(key))).status,
    401,
  )
  strictEqual(
    (await post(f.gateway.localPort, '/auth/pair', grant(key))).status,
    403,
  )
  permitted = true
  await delay(40)
  strictEqual(
    (await post(f.gateway.localPort, '/auth/account', grant(key))).status,
    200,
  )
})

void test('temporary account-check failures preserve existing sessions and block new authorizations', async (context) => {
  const key = '34'.repeat(32)
  let unavailable = false
  const failedCheck = Promise.withResolvers<void>()
  const f = await fixture(context, undefined, {
    key,
    check: async () => {
      if (unavailable) {
        failedCheck.resolve()
        throw new Error('backend unavailable')
      }
      return true
    },
  })
  const response = await post(f.gateway.localPort, '/auth/account', grant(key))
  const session = ((await response.json()) as { sessionToken: string })
    .sessionToken
  unavailable = true
  await failedCheck.promise
  await delay(0)
  strictEqual(
    (await post(f.gateway.localPort, '/auth/session', session)).status,
    200,
  )
  await f.ticket(session, 'file-system-process')
  strictEqual(
    (await post(f.gateway.localPort, '/auth/account', grant(key))).status,
    401,
  )
})

void test('managed tunnels never issue pairing URLs or accept anonymous or pairing credentials', async (context) => {
  const key = '34'.repeat(32)
  const f = await fixture(context, undefined, { key, check: async () => true })
  strictEqual(f.gateway.pairingUrl, undefined)
  throws(() => f.gateway.pair(), /require LVCE account sign-in/)
  for (const token of ['', randomBytes(32).toString('hex'), grant(key)]) {
    strictEqual(
      (await post(f.gateway.localPort, '/auth/pair', token)).status,
      403,
    )
    strictEqual(
      (await post(f.gateway.localPort, '/auth/session', token)).status,
      401,
    )
    strictEqual(
      (
        await post(
          f.gateway.localPort,
          '/auth/websocket-ticket?process=file-system-process',
          token,
        )
      ).status,
      401,
    )
  }
  strictEqual(
    (await post(f.gateway.localPort, '/auth/account', '')).status,
    401,
  )
  strictEqual(
    (await post(f.gateway.localPort, '/auth/account', grant('56'.repeat(32))))
      .status,
    401,
  )
  strictEqual(
    await expectRejectedWebSocket(
      f.socketUrl('file-system-process', 'anonymous'),
      allowedOrigin,
    ),
    401,
  )
  strictEqual(f.requests.length, 0)
  const owner = await post(f.gateway.localPort, '/auth/account', grant(key))
  strictEqual(owner.status, 200)
  const { sessionToken } = (await owner.json()) as { sessionToken: string }
  await f.ticket(sessionToken, 'file-system-process')
})
