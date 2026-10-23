import { chmod } from 'node:fs/promises'
import { createServer, createConnection } from 'node:net'
import type { RemoteWebGateway } from './RemoteWebGateway.ts'

/** The containing directory must be private to the remote OS account. */
export const listen = async (
  socketPath: string,
  gateway: RemoteWebGateway,
): Promise<() => Promise<void>> => {
  const clients = new Set<ReturnType<typeof createConnection>>()
  const server = createServer((socket) => {
    clients.add(socket)
    socket.setTimeout(5000, () => socket.destroy())
    socket.once('close', () => clients.delete(socket))
    socket.on('error', () => socket.destroy())
    let input = ''
    socket.on('data', (data) => {
      input += data.toString('utf8')
      if (input.length > 128) {
        socket.destroy()
        return
      }
      if (!input.includes('\n')) return
      const command = input.trim()
      if (command === 'pair')
        socket.end(`${JSON.stringify({ pairingUrl: gateway.pair() })}\n`)
      else if (command === 'revoke') {
        gateway.revoke()
        socket.end('{"ok":true}\n')
      } else socket.destroy()
    })
  })
  server.maxConnections = 8
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  await chmod(socketPath, 0o600)
  return async () => {
    for (const client of clients) client.destroy()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

export const request = async (
  socketPath: string,
  command: 'pair' | 'revoke',
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let response = ''
    socket.setTimeout(5000, () =>
      socket.destroy(new Error('Remote web control timed out')),
    )
    socket.once('connect', () => socket.write(`${command}\n`))
    socket.on('data', (data) => {
      response += data.toString('utf8')
    })
    socket.once('end', () => resolve(response))
    socket.once('error', reject)
  })
}
