import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import type { OpenRequest } from '../src/parts/SshTransport/SshTransport.ts'
import {
  ConnectionSession,
  type Transport,
} from '../src/parts/ConnectionSession/ConnectionSession.ts'

const fixture = (
  name: string,
): Transport & {
  readonly events: ReturnType<typeof Promise.withResolvers<OpenRequest>>
  readonly calls: string[]
} => {
  const events = Promise.withResolvers<OpenRequest>()
  const calls: string[] = []
  return {
    calls,
    disposeBackendRpcs: (): void => {
      calls.push('dispose')
    },
    events,
    forwardPort: async (
      _workspace,
      remotePort,
    ): Promise<{ localPort: number; remotePort: number }> => ({
      localPort: remotePort,
      remotePort,
    }),
    getForwardedPorts: async () => [],
    getWorkspaceBackend: async () => ({ token: name, url: `ws://${name}` }),
    invokeBackend: async (_type, method): Promise<string> => {
      calls.push(method)
      return name
    },
    stopForwardPort: async (): Promise<void> => {},
    waitForOpenRequest: () => events.promise,
  }
}

void test('drains writes once, queues new requests during handover, preserves the endpoint and rolls back on disconnect', async () => {
  const controller = new AbortController()
  const old = fixture('old')
  const updated = fixture('new')
  const write = Promise.withResolvers<unknown>()
  const writes: string[] = []
  const original = {
    ...old,
    invokeBackend: async (_type: string, method: string): Promise<unknown> => {
      writes.push(method)
      return write.promise
    },
  }
  let route = 'old'
  const stable = { token: 'stable', url: 'ws://stable' }
  const session = new ConnectionSession(
    original,
    {
      backend: stable,
      setBackend: (backend): void => {
        route = backend.token
      },
    },
    controller.signal,
    () => {
      throw new Error('Unexpected session close')
    },
  )
  const pendingWrite = session.invokeBackend('file-system-process', 'write', [])
  const switching = session.switchTo(updated)
  const read = session.invokeBackend('file-system-process', 'read', [])
  strictEqual(route, 'old')
  deepStrictEqual(updated.calls, [])
  write.resolve('saved')
  strictEqual(await pendingWrite, 'saved')
  await switching
  strictEqual(await read, 'new')
  strictEqual(route, 'new')
  deepStrictEqual(writes, ['write'])
  deepStrictEqual(old.calls, ['dispose'])
  strictEqual(await session.getWorkspaceBackend(), stable)
  session.connectionClosed(updated)
  await Promise.resolve()
  strictEqual(route, 'old')
  controller.abort()
  await rejects(session.invokeBackend('file-system-process', 'write', []))
})

void test('failed handover retains original requests and cancellation rejects CLI waiters', async () => {
  const controller = new AbortController()
  const original = fixture('old')
  const failed = {
    ...fixture('new'),
    getWorkspaceBackend: async (): Promise<never> => {
      throw new Error('probe failed')
    },
  }
  const session = new ConnectionSession(
    original,
    {
      backend: { token: 'stable', url: 'ws://stable' },
      setBackend: (): void => {
        throw new Error('Unexpected route switch')
      },
    },
    controller.signal,
    () => {},
  )
  await rejects(session.switchTo(failed), /probe failed/)
  strictEqual(
    await session.invokeBackend('file-system-process', 'read', []),
    'old',
  )
  const cli = session.waitForOpenRequest()
  controller.abort()
  await rejects(cli, /closed/)
})
