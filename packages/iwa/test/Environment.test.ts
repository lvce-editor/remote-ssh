import assert from 'node:assert/strict'
import test from 'node:test'
import { getEnvironmentStatus } from '../src/Environment.ts'

void test('explains why a normal web page cannot use Direct Sockets', () => {
  const status = getEnvironmentStatus({ TCPSocket: undefined })

  assert.equal(status.available, false)
  assert.match(status.message, /Isolated Web App/)
})

void test('reports Direct Sockets as available', () => {
  class MockTcpSocket {
    close = async (): Promise<void> => {}
    opened = Promise.resolve({
      readable: new ReadableStream<Uint8Array>(),
      writable: new WritableStream<Uint8Array>(),
    })
  }
  const status = getEnvironmentStatus({ TCPSocket: MockTcpSocket })

  assert.equal(status.available, true)
})
