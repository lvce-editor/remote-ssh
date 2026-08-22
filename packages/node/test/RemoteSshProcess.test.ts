import type { Rpc } from '@lvce-editor/rpc'
import type { Duplex } from 'node:stream'
import {
  NodeForkedProcessRpcParent,
  WebSocketRpcParent,
} from '@lvce-editor/rpc'
import { deepStrictEqual, ok } from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

void test('starts the packaged Remote SSH process and invokes a representative command', async () => {
  const server = createServer()
  const sockets = new Set<Duplex>()
  let controlRpc: Rpc | undefined
  let rpc: Rpc | undefined
  try {
    const processPath = fileURLToPath(
      new URL('../../extension/dist/remoteSshProcess.js', import.meta.url),
    )
    const childRpc = await NodeForkedProcessRpcParent.create({
      commandMap: {},
      path: processPath,
    })
    controlRpc = childRpc
    const { promise: attached, reject, resolve } = Promise.withResolvers<void>()
    server.on('upgrade', (request, socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.pause()
      const serializableRequest = {
        headers: request.headers,
        method: request.method,
        url: request.url,
      }
      const attach = async (): Promise<void> => {
        try {
          await childRpc.invokeAndTransfer(
            'NodeRpcProcess.handleWebSocket',
            socket,
            serializableRequest,
          )
          resolve()
        } catch (error) {
          reject(error)
        }
      }
      void attach()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    ok(address && typeof address === 'object')
    const webSocket = new WebSocket(`ws://127.0.0.1:${address.port}`)
    rpc = await WebSocketRpcParent.create({ commandMap: {}, webSocket })
    await attached

    const hosts = await rpc.invoke('SshConfigHosts.get')

    deepStrictEqual(Array.isArray(hosts), true)
  } finally {
    await rpc?.dispose()
    await controlRpc?.dispose()
    for (const socket of sockets) {
      socket.destroy()
    }
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
