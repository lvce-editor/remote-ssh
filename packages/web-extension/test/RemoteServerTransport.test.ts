import { expect, test } from '@jest/globals'
import { getTerminalMessage } from '../src/parts/RemoteServerConnection/RemoteServerTransport.ts'

test('maps terminal directories to remote paths without changing input messages', () => {
  const message = {
    id: 1,
    method: 'Terminal.create',
    params: [7, 'remote-server://host/home/a%20b', 80, 24],
  }
  expect(getTerminalMessage(message, 'remote-server://host/home')).toEqual({
    ...message,
    params: [7, '/home/a b', 80, 24],
  })
  expect(message.params[1]).toBe('remote-server://host/home/a%20b')
  expect(
    getTerminalMessage(
      { method: 'Terminal.write', params: [7, 'echo hello'] },
      'remote-server://host/home',
    ),
  ).toEqual({ method: 'Terminal.write', params: [7, 'echo hello'] })
})

test('rejects terminal directories from another remote server', () => {
  expect(() =>
    getTerminalMessage(
      { method: 'Terminal.create', params: [7, 'remote-server://other/home'] },
      'remote-server://host/home',
    ),
  ).toThrow('different server')
})

test('accepts absolute remote directories supplied by the renderer workspace connection', () => {
  const message = {
    method: 'Terminal.create',
    params: [1, '/home/project', 'bash', ['-i']],
  }
  expect(getTerminalMessage(message, 'remote-server://host/home/project')).toBe(
    message,
  )
})
