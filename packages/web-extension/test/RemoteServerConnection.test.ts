import { afterEach, expect, jest, test } from '@jest/globals'
import * as RemoteServerConnection from '../src/parts/RemoteServerConnection/RemoteServerConnection.ts'

class MockWebSocket {
  onclose: ((event: any) => void) | null = null
  onerror: ((event: any) => void) | null = null
  onmessage: ((event: any) => void) | null = null
  onopen: ((event: any) => void) | null = null

  bufferedAmount = 0
  close = jest.fn()
  send = jest.fn<(data: string) => void>()
}

const waitForWebSocket = async (
  sockets: readonly MockWebSocket[],
): Promise<void> => {
  for (let i = 0; i < 10 && sockets.length === 0; i++) {
    await Promise.resolve()
  }
  if (sockets.length === 0) {
    throw new Error('WebSocket was not created')
  }
}

afterEach(async () => {
  jest.restoreAllMocks()
  await RemoteServerConnection.dispose()
})

test('exchanges the session for a process-specific WebSocket ticket', async () => {
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    json: async () => ({ ticket: 'short-lived-ticket' }),
    ok: true,
  } as Response)
  RemoteServerConnection.set({
    sessionToken: 'session-secret',
    websocketUrl: 'wss://remote.example.com/',
  })

  await expect(
    RemoteServerConnection.getWebSocketUrl('terminal-process'),
  ).resolves.toBe(
    'wss://remote.example.com/websocket/terminal-process?ticket=short-lived-ticket',
  )
  expect(fetchSpy).toHaveBeenCalledWith(
    new URL(
      'https://remote.example.com/auth/websocket-ticket?process=terminal-process',
    ),
    {
      headers: { authorization: 'Bearer session-secret' },
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    },
  )
})

test('uses HTTP only for an authenticated loopback WebSocket', async () => {
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    json: async () => ({ ticket: 'short-lived-ticket' }),
    ok: true,
  } as Response)
  RemoteServerConnection.set({
    sessionToken: 'session-secret',
    websocketUrl: 'ws://127.0.0.1:3774/',
  })

  await expect(
    RemoteServerConnection.getWebSocketUrl('terminal-process'),
  ).resolves.toBe(
    'ws://127.0.0.1:3774/websocket/terminal-process?ticket=short-lived-ticket',
  )
  expect(fetchSpy).toHaveBeenCalledWith(
    new URL(
      'http://127.0.0.1:3774/auth/websocket-ticket?process=terminal-process',
    ),
    {
      headers: { authorization: 'Bearer session-secret' },
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    },
  )
})

test('rejects an invalid ticket response', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    json: async () => ({}),
    ok: true,
  } as Response)
  RemoteServerConnection.set({
    sessionToken: 'session-secret',
    websocketUrl: 'wss://remote.example.com/',
  })

  await expect(
    RemoteServerConnection.getWebSocketUrl('terminal-process'),
  ).rejects.toMatchObject({
    code: 'E_REMOTE_SERVER_WEBSOCKET_AUTH_INVALID_RESPONSE',
    message: 'Remote server returned an invalid WebSocket ticket',
  })
})

test('explains a missing WebSocket authorization endpoint with an error code', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: false,
    status: 404,
    statusText: 'Not Found',
  } as Response)
  RemoteServerConnection.set({
    sessionToken: 'session-secret',
    websocketUrl: 'wss://remote.example.com/',
  })

  await expect(
    RemoteServerConnection.getWebSocketUrl('terminal-process'),
  ).rejects.toMatchObject({
    code: 'E_REMOTE_SERVER_WEBSOCKET_AUTH_HTTP_ERROR',
    message:
      'Failed to authorize the remote WebSocket: HTTP 404 Not Found. The remote server does not provide the WebSocket ticket endpoint.',
  })
})

test('explains a server-side WebSocket authorization failure', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
  } as Response)
  RemoteServerConnection.set({
    sessionToken: 'session-secret',
    websocketUrl: 'wss://remote.example.com/',
  })

  await expect(
    RemoteServerConnection.getWebSocketUrl('terminal-process'),
  ).rejects.toMatchObject({
    code: 'E_REMOTE_SERVER_WEBSOCKET_AUTH_HTTP_ERROR',
    message:
      'Failed to authorize the remote WebSocket: HTTP 503 Service Unavailable. The remote server is temporarily unavailable.',
  })
})

test('reports a coded network failure while authorizing the WebSocket', async () => {
  const cause = Object.assign(new Error('connect ECONNREFUSED'), {
    code: 'ECONNREFUSED',
  })
  jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new TypeError('fetch failed', { cause }))
  RemoteServerConnection.set({
    sessionToken: 'session-secret',
    websocketUrl: 'wss://remote.example.com/',
  })

  await expect(
    RemoteServerConnection.getWebSocketUrl('terminal-process'),
  ).rejects.toMatchObject({
    code: 'E_REMOTE_SERVER_WEBSOCKET_AUTH_NETWORK_ERROR',
    message: 'Failed to authorize the remote WebSocket: connect ECONNREFUSED.',
  })
})

test('reports a coded WebSocket connection error with transport details', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    json: async () => ({ ticket: 'short-lived-ticket' }),
    ok: true,
  } as Response)
  const sockets: MockWebSocket[] = []
  jest.spyOn(globalThis, 'WebSocket').mockImplementation(() => {
    const socket = new MockWebSocket()
    sockets.push(socket)
    return socket as unknown as WebSocket
  })
  RemoteServerConnection.set({
    sessionToken: 'session-secret',
    websocketUrl: 'wss://remote.example.com/',
  })

  const request = RemoteServerConnection.invoke('FileSystem.stat', '/tmp')
  await waitForWebSocket(sockets)
  sockets[0].onerror?.({
    error: new Error('Received unexpected server response: 502'),
  })

  await expect(request).rejects.toMatchObject({
    code: 'E_REMOTE_SERVER_WEBSOCKET_ERROR',
    message:
      'Remote server WebSocket failed: Received unexpected server response: 502',
    name: 'RemoteServerError',
  })
})

test('reports a coded WebSocket close with the server reason', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    json: async () => ({ ticket: 'short-lived-ticket' }),
    ok: true,
  } as Response)
  const sockets: MockWebSocket[] = []
  jest.spyOn(globalThis, 'WebSocket').mockImplementation(() => {
    const socket = new MockWebSocket()
    sockets.push(socket)
    return socket as unknown as WebSocket
  })
  RemoteServerConnection.set({
    sessionToken: 'session-secret',
    websocketUrl: 'wss://remote.example.com/',
  })

  const request = RemoteServerConnection.invoke('FileSystem.stat', '/tmp')
  await waitForWebSocket(sockets)
  sockets[0].onclose?.({ code: 1011, reason: 'remote process crashed' })

  await expect(request).rejects.toMatchObject({
    code: 'E_REMOTE_SERVER_WEBSOCKET_CLOSED',
    message:
      'Remote server WebSocket closed (close code 1011: remote process crashed)',
  })
})

test('reports a coded unpaired server error', async () => {
  await RemoteServerConnection.dispose()
  await expect(
    RemoteServerConnection.invoke('FileSystem.stat', '/'),
  ).rejects.toMatchObject({
    code: 'E_REMOTE_SERVER_NOT_PAIRED',
    name: 'RemoteServerError',
  })
  await expect(
    RemoteServerConnection.getWebSocketUrl('terminal-process'),
  ).rejects.toMatchObject({
    code: 'E_REMOTE_SERVER_NOT_PAIRED',
  })
})

test('does not create a WebSocket after disposal while ticket authorization is pending', async () => {
  const { promise, resolve } = Promise.withResolvers<Response>()
  jest.spyOn(globalThis, 'fetch').mockReturnValue(promise)
  const createSocket = jest.spyOn(globalThis, 'WebSocket')
  RemoteServerConnection.set({
    sessionToken: 'old-session',
    websocketUrl: 'wss://remote.example.com/',
  })
  const pending = RemoteServerConnection.getWebSocketUrl('terminal-process')
  await RemoteServerConnection.dispose()
  resolve({
    json: async () => ({ ticket: 'late-ticket' }),
    ok: true,
  } as Response)
  await expect(pending).rejects.toThrow('changed while authorizing')
  expect(createSocket).not.toHaveBeenCalled()
})

test('binds extension process parameters when issuing the ticket', async () => {
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    json: async () => ({ ticket: 'extension-ticket' }),
    ok: true,
  } as Response)
  RemoteServerConnection.set({
    sessionToken: 'session',
    websocketUrl: 'wss://remote.example.com/',
  })
  const url = await RemoteServerConnection.getWebSocketUrl(
    'extension-node-process',
    { extensionId: 'builtin.git', rpcId: 'git-client' },
  )
  expect(new URL(url).searchParams.get('rpcId')).toBe('git-client')
  expect(fetchSpy.mock.calls[0]?.[0]).toEqual(
    new URL(
      'https://remote.example.com/auth/websocket-ticket?process=extension-node-process&extensionId=builtin.git&rpcId=git-client',
    ),
  )
})

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const mockConnections = (): MockWebSocket[] => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    json: async () => ({ ticket: 'fresh-ticket' }),
    ok: true,
  } as Response)
  const sockets: MockWebSocket[] = []
  jest.spyOn(globalThis, 'WebSocket').mockImplementation(() => {
    const socket = new MockWebSocket()
    sockets.push(socket)
    return socket as unknown as WebSocket
  })
  RemoteServerConnection.set({
    sessionToken: 'session-secret',
    websocketUrl: 'wss://remote.example.com/',
  })
  return sockets
}

test('rejects an uncertain write on disconnect and opens a fresh socket without replaying it', async () => {
  const sockets = mockConnections()
  const write = RemoteServerConnection.invoke(
    'FileSystem.writeFile',
    '/tmp/file',
    'text',
  )
  void write.catch(() => {})
  await waitForWebSocket(sockets)
  sockets[0].onopen?.({})
  await flush()
  expect(sockets[0].send).toHaveBeenCalledTimes(1)
  sockets[0].onclose?.({ code: 1006, reason: '' })
  await expect(write).rejects.toMatchObject({
    code: 'E_REMOTE_SERVER_WEBSOCKET_CLOSED',
  })

  const read = RemoteServerConnection.invoke('FileSystem.stat', '/tmp/file')
  await flush()
  expect(sockets).toHaveLength(2)
  sockets[1].onopen?.({})
  await flush()
  const request = JSON.parse(sockets[1].send.mock.calls[0][0])
  expect(request.method).toBe('FileSystem.stat')
  expect(sockets[1].send).toHaveBeenCalledTimes(1)
  sockets[1].onmessage?.({
    data: JSON.stringify({ id: request.id, result: { size: 4 } }),
  })
  await expect(read).resolves.toEqual({ size: 4 })
})

test('switching workspace closes sockets and rejects outstanding requests from the old generation', async () => {
  const sockets = mockConnections()
  const read = RemoteServerConnection.invoke('FileSystem.stat', '/old')
  void read.catch(() => {})
  await waitForWebSocket(sockets)
  sockets[0].onopen?.({})
  await flush()
  const disposeBridge = jest.fn()
  RemoteServerConnection.trackConnection(disposeBridge)
  RemoteServerConnection.set({
    sessionToken: 'new-session',
    websocketUrl: 'wss://another.example.com/',
  })
  await expect(read).rejects.toMatchObject({
    code: 'E_REMOTE_SERVER_CONNECTION_CLOSED',
  })
  expect(sockets[0].close).toHaveBeenCalled()
  expect(disposeBridge).toHaveBeenCalledTimes(1)
  expect(RemoteServerConnection.getStatus()).toContain('another.example.com')
})

test('expired or revoked authorization clears the in-memory session', async () => {
  mockConnections()
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue({ ok: false, status: 401 } as Response)
  await expect(
    RemoteServerConnection.getWebSocketUrl('terminal-process'),
  ).rejects.toThrow('expired or revoked')
  expect(RemoteServerConnection.getOptions()).toBeUndefined()
})
