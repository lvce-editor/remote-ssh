import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { create } from '../src/parts/WorkspaceBackendRpc/WorkspaceBackendRpc.ts'

class MockWebSocket {
  readonly sent: string[] = []
  onclose: ((event: any) => void) | null = null
  onerror: ((event: any) => void) | null = null
  onmessage: ((event: any) => void) | null = null
  onopen: ((event: any) => void) | null = null

  close(): void {}

  send(value: string): void {
    this.sent.push(value)
  }
}

void test('carries concurrent JSON-RPC requests over one WebSocket', async () => {
  const socket = new MockWebSocket()
  const rpc = create('ws://127.0.0.1', () => socket)
  socket.onopen?.({})

  const first = rpc.invoke('FileSystem.readFile', '/one', 'base64')
  const second = rpc.invoke('FileSystem.readFile', '/two', 'base64')
  await Promise.resolve()
  deepStrictEqual(
    socket.sent.map((value) => JSON.parse(value)),
    [
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'FileSystem.readFile',
        params: ['/one', 'base64'],
      },
      {
        id: 2,
        jsonrpc: '2.0',
        method: 'FileSystem.readFile',
        params: ['/two', 'base64'],
      },
    ],
  )

  socket.onmessage?.({
    data: JSON.stringify({ id: 2, jsonrpc: '2.0', result: 'two' }),
  })
  socket.onmessage?.({
    data: JSON.stringify({ id: 1, jsonrpc: '2.0', result: 'one' }),
  })
  strictEqual(await first, 'one')
  strictEqual(await second, 'two')
})

void test('rejects pending requests when the transport closes', async () => {
  const socket = new MockWebSocket()
  const rpc = create('ws://127.0.0.1', () => socket)
  socket.onopen?.({})
  const request = rpc.invoke('FileSystem.stat', '/tmp')
  await Promise.resolve()
  socket.onclose?.({})
  await rejects(request, /WebSocket closed/)
})

void test('preserves remote errno codes', async () => {
  const socket = new MockWebSocket()
  const rpc = create('ws://127.0.0.1', () => socket)
  socket.onopen?.({})
  const request = rpc.invoke('FileSystem.readFile', '/missing')
  socket.onmessage?.({
    data: JSON.stringify({
      error: { code: -32_603, data: { code: 'ENOENT' }, message: 'missing' },
      id: 1,
      jsonrpc: '2.0',
    }),
  })
  await rejects(request, (error: NodeJS.ErrnoException) => {
    strictEqual(error.message, 'missing')
    strictEqual(error.code, 'ENOENT')
    return true
  })
})
