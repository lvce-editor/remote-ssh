import { afterEach, expect, jest, test } from '@jest/globals'
import * as RemoteServerConnection from '../src/parts/RemoteServerConnection/RemoteServerConnection.ts'

class MockWebSocket {
  onclose: ((event: any) => void) | null = null
  onerror: ((event: any) => void) | null = null
  onmessage: ((event: any) => void) | null = null
  onopen: ((event: any) => void) | null = null

  close(): void {}
  send(): void {}
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
    new URL('https://remote.example.com/auth/websocket-ticket'),
    {
      headers: { authorization: 'Bearer session-secret' },
      method: 'POST',
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
    new URL('http://127.0.0.1:3774/auth/websocket-ticket'),
    {
      headers: { authorization: 'Bearer session-secret' },
      method: 'POST',
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
