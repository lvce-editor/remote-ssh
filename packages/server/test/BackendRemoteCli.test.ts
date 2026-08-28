import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { open } from '../src/parts/BackendRemoteCli/BackendRemoteCli.ts'

class MockWebSocket {
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onopen: (() => void) | null = null
  readonly sent: string[] = []

  close(): void {}

  send(value: string): void {
    this.sent.push(value)
  }
}

void test('publishes an open request to the remote shared process', async () => {
  const socket = new MockWebSocket()
  let url = ''
  const result = open(
    { port: 45123, token: 'secret' },
    { kind: 'folder', path: '/home/project', type: 'open' },
    (value) => {
      url = value
      return socket
    },
  )

  socket.onopen?.()
  deepStrictEqual(JSON.parse(socket.sent[0]), {
    id: 1,
    jsonrpc: '2.0',
    method: 'RemoteCli.open',
    params: [{ kind: 'folder', path: '/home/project', type: 'open' }],
  })
  socket.onmessage?.({ data: JSON.stringify({ id: 1, result: true }) })

  strictEqual(await result, true)
  strictEqual(url, 'ws://127.0.0.1:45123/websocket/shared-process?token=secret')
})

void test('retries while a connected window replaces its long poll', async () => {
  const socket = new MockWebSocket()
  const result = open(
    { port: 45123, token: 'secret' },
    { kind: 'folder', path: '/home/project', type: 'open' },
    () => socket,
    async () => {},
  )

  socket.onopen?.()
  socket.onmessage?.({ data: JSON.stringify({ id: 1, result: false }) })
  await new Promise((resolve) => setImmediate(resolve))

  strictEqual(socket.sent.length, 2)
  socket.onmessage?.({ data: JSON.stringify({ id: 1, result: true }) })
  strictEqual(await result, true)
})

void test('stops retrying when no local window is connected', async () => {
  const socket = new MockWebSocket()
  const result = open(
    { port: 45123, token: 'secret' },
    { kind: 'folder', path: '/home/project', type: 'open' },
    () => socket,
    async () => {},
  )

  socket.onopen?.()
  for (let attempt = 0; attempt < 10; attempt++) {
    socket.onmessage?.({ data: JSON.stringify({ id: 1, result: false }) })
    await new Promise((resolve) => setImmediate(resolve))
  }

  strictEqual(socket.sent.length, 10)
  strictEqual(await result, false)
})

void test('reports backend command errors', async () => {
  const socket = new MockWebSocket()
  const result = open(
    { port: 45123, token: 'secret' },
    { kind: 'folder', path: '/home/project', type: 'open' },
    () => socket,
  )

  socket.onopen?.()
  socket.onmessage?.({
    data: JSON.stringify({ id: 1, error: { message: 'command not found' } }),
  })

  await rejects(result, /command not found/)
})
