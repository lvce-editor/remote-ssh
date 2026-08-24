import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectSocketTransport } from '../src/DirectSocketTransport.ts'

void test('carries bytes over a Direct Socket', async () => {
  const received: Uint8Array[] = []
  const written: Uint8Array[] = []
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false
  const socket = {
    close: async (): Promise<void> => {
      closed = true
    },
    opened: Promise.resolve({
      readable: new ReadableStream<Uint8Array>({
        start(value): void {
          controller = value
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(value): void {
          written.push(value)
        },
      }),
    }),
  }
  const transport = new DirectSocketTransport(
    'test',
    'example.com',
    22,
    (): typeof socket => socket,
  )
  transport.onData = (value): void => {
    received.push(value)
  }

  await transport.connect()
  await transport.send(Uint8Array.of(1, 2, 3))
  controller?.enqueue(Uint8Array.of(4, 5, 6))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await transport.disconnect()

  assert.deepEqual(written, [Uint8Array.of(1, 2, 3)])
  assert.deepEqual(received, [Uint8Array.of(4, 5, 6)])
  assert.equal(closed, true)
})

void test('rejects writes before connecting', async () => {
  const transport = new DirectSocketTransport('test', 'example.com', 22, () => {
    throw new Error('not used')
  })

  await assert.rejects(transport.send(Uint8Array.of(1)), /not connected/)
})
