import { afterEach, expect, test } from '@jest/globals'
import * as WorkspaceConnection from '../src/parts/WorkspaceConnection/WorkspaceConnection.ts'

afterEach(() => {
  WorkspaceConnection.reset()
})

test('creates an authenticated process URL', () => {
  WorkspaceConnection.set({
    token: 'backend-secret',
    url: 'ws://127.0.0.1:45123',
  })

  expect(WorkspaceConnection.getWebSocketUrl('terminal-process')).toBe(
    'ws://127.0.0.1:45123/websocket/terminal-process?token=backend-secret',
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

test('requires a connected SSH backend', () => {
  expect(() => WorkspaceConnection.getWebSocketUrl('terminal-process')).toThrow(
    /not available/,
  )
})
