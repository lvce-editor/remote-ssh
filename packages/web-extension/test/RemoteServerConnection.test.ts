import { afterEach, expect, jest, test } from '@jest/globals'
import * as RemoteServerConnection from '../src/parts/RemoteServerConnection/RemoteServerConnection.ts'

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
  ).rejects.toThrow(/invalid WebSocket ticket/)
})
