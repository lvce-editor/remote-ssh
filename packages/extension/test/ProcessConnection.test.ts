import { afterEach, expect, jest, test } from '@jest/globals'
import {
  bridge,
  dispose,
  getTerminalMessage,
} from '../src/parts/ProcessConnection/ProcessConnection.ts'

const once = (port: MessagePort, name: string): Promise<readonly unknown[]> =>
  new Promise((resolve) => {
    port.addEventListener(
      name,
      (event) => resolve([(event as MessageEvent).data]),
      { once: true },
    )
    port.start()
  })

interface MockSocket {
  close: ReturnType<typeof jest.fn>
  onclose: undefined | (() => void)
  onerror: undefined | (() => void)
  onmessage: undefined | ((event: { data: string }) => void)
  onopen: undefined | (() => void)
  send: ReturnType<typeof jest.fn<(data: string) => void>>
}

const createSocket = (): MockSocket => ({
  close: jest.fn(),
  onclose: undefined as undefined | (() => void),
  onerror: undefined as undefined | (() => void),
  onmessage: undefined as undefined | ((event: { data: string }) => void),
  onopen: undefined as undefined | (() => void),
  send: jest.fn<(data: string) => void>(),
})

afterEach(dispose)

test('queues port messages until open and relays the remote handshake and responses', async () => {
  const { port1, port2 } = new MessageChannel()
  const socket = createSocket()
  const opened = bridge(port1, socket as unknown as WebSocket)
  try {
    port2.postMessage({ id: 1, method: 'Git.status' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(socket.send).not.toHaveBeenCalled()
    const sent = new Promise<void>((resolve) =>
      socket.send.mockImplementation(() => resolve()),
    )
    socket.onopen?.()
    await opened
    await sent
    expect(socket.send).toHaveBeenCalledWith('{"id":1,"method":"Git.status"}')
    const response = once(port2, 'message')
    socket.onmessage?.({ data: '{"id":1,"result":["changed.txt"]}' })
    await expect(response).resolves.toEqual([
      { id: 1, result: ['changed.txt'] },
    ])
  } finally {
    port2.close()
  }
})

test('closes both ends on invalid JSON', async () => {
  const { port1, port2 } = new MessageChannel()
  const socket = createSocket()
  const opened = bridge(port1, socket as unknown as WebSocket)
  socket.onopen?.()
  await opened
  const closed = once(port2, 'close')
  socket.onmessage?.({ data: 'invalid' })
  await closed
  expect(socket.close).toHaveBeenCalledTimes(1)
})

test('rejects a failed connection and releases its port', async () => {
  const { port1, port2 } = new MessageChannel()
  const socket = createSocket()
  const opened = bridge(port1, socket as unknown as WebSocket)
  const closed = once(port2, 'close')
  socket.onerror?.()
  await expect(opened).rejects.toThrow('closed before opening')
  await closed
  expect(socket.close).toHaveBeenCalledTimes(1)
})

test('closing a client port releases the remote process connection', async () => {
  const { port1, port2 } = new MessageChannel()
  const socket = createSocket()
  const opened = bridge(port1, socket as unknown as WebSocket)
  socket.onopen?.()
  await opened
  const closed = once(port1, 'close')
  port2.close()
  await closed
  expect(socket.close).toHaveBeenCalledTimes(1)
})

test('deactivation closes all sockets including connections still opening', async () => {
  const { port1, port2 } = new MessageChannel()
  const socket = createSocket()
  const opened = bridge(port1, socket as unknown as WebSocket)
  dispose()
  await expect(opened).rejects.toThrow('closed before opening')
  expect(socket.close).toHaveBeenCalledTimes(1)
  dispose()
  expect(socket.close).toHaveBeenCalledTimes(1)
  port2.close()
})

test('terminal requests use a decoded directory on the connected host', () => {
  const message = {
    id: 1,
    method: 'Terminal.create',
    params: [12, 'remote-ssh://user@host/work/my%20folder', 'bash', []],
  }
  expect(getTerminalMessage(message, 'remote-ssh://user@host/work')).toEqual({
    ...message,
    params: [12, '/work/my folder', 'bash', []],
  })
  expect(() => getTerminalMessage(message, 'remote-ssh://other/work')).toThrow(
    'different workspace host',
  )
  expect(
    getTerminalMessage(
      { method: 'Terminal.write', params: [12, 'remote-ssh://literal'] },
      'remote-ssh://user@host/work',
    ),
  ).toEqual({ method: 'Terminal.write', params: [12, 'remote-ssh://literal'] })
})
