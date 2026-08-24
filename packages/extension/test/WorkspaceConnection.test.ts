import { afterEach, expect, test } from '@jest/globals'
import * as WorkspaceConnection from '../src/parts/WorkspaceConnection/WorkspaceConnection.ts'

afterEach(() => {
  WorkspaceConnection.reset()
})

test('creates an authenticated process URL', async () => {
  WorkspaceConnection.set({
    token: 'backend-secret',
    url: 'ws://127.0.0.1:45123',
  })

  await expect(
    WorkspaceConnection.getWebSocketUrl('terminal-process'),
  ).resolves.toBe(
    'ws://127.0.0.1:45123/websocket/terminal-process?token=backend-secret',
  )
})

test('waits for the workspace backend while the extension restores', async () => {
  const result = WorkspaceConnection.getWebSocketUrl('file-system-process')

  await Promise.resolve()
  WorkspaceConnection.set({
    token: 'backend-secret',
    url: 'ws://127.0.0.1:45123',
  })

  await expect(result).resolves.toBe(
    'ws://127.0.0.1:45123/websocket/file-system-process?token=backend-secret',
  )
})

test('rejects a non-loopback SSH backend', () => {
  expect(() =>
    WorkspaceConnection.set({
      token: 'backend-secret',
      url: 'wss://remote.example.com',
    }),
  ).toThrow(/loopback/)
})

test('rejects a pending request when the workspace connection resets', async () => {
  const result = WorkspaceConnection.getWebSocketUrl('terminal-process')

  WorkspaceConnection.reset()

  await expect(result).rejects.toThrow(/not available/)
})
