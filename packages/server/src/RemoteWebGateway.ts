import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'

const pairingTtl = 10 * 60 * 1000
const sessionTtl = 24 * 60 * 60 * 1000
const ticketTtl = 5 * 60 * 1000
const allowedProcesses = new Set([
  'extension-node-process',
  'file-system-process',
  'process-explorer',
  'search-process',
  'terminal-process',
])

interface GatewayOptions {
  readonly allowedOrigin: string
  readonly backendPort: number
  readonly backendToken: string
  readonly port: number
  readonly publicUrl: string
  readonly workspacePath: string
}

export interface RemoteWebGateway {
  readonly close: () => Promise<void>
  readonly localPort: number
  readonly pairingUrl: string
}

const getBearerToken = (request: IncomingMessage): string => {
  const value = request.headers.authorization || ''
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length) : ''
}

const tokensEqual = (actual: string, expected: string): boolean => {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  )
}

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void => {
  const body = JSON.stringify(value)
  response.writeHead(statusCode, {
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json',
  })
  response.end(body)
}

const rejectUpgrade = (socket: Duplex, status: string): void => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
}

const isLoopback = (url: URL): boolean => {
  return (
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]'
  )
}

const validatePublicUrl = (url: URL, option = '--public-url'): void => {
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopback(url))
  ) {
    throw new TypeError(
      `${option} must use https (or loopback http for development)`,
    )
  }
}

const pruneExpired = (values: Map<string, number>): void => {
  const now = Date.now()
  for (const [token, expiresAt] of values) {
    if (now >= expiresAt) {
      values.delete(token)
    }
  }
}

const toWebSocketUrl = (value: string): string => {
  const url = new URL(value)
  validatePublicUrl(url)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.hash = ''
  url.pathname = '/'
  url.search = ''
  return url.href
}

const getBackendUrl = (options: GatewayOptions, processType: string): URL => {
  const url = new URL(
    `/websocket/${encodeURIComponent(processType)}`,
    `ws://127.0.0.1:${options.backendPort}`,
  )
  url.searchParams.set('token', options.backendToken)
  return url
}

const waitForOpen = (webSocket: WebSocket): Promise<void> => {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      webSocket.off('close', onClose)
      webSocket.off('error', onError)
      webSocket.off('open', onOpen)
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('LVCE workspace backend closed before opening'))
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onOpen = (): void => {
      cleanup()
      resolve()
    }
    webSocket.once('close', onClose)
    webSocket.once('error', onError)
    webSocket.once('open', onOpen)
  })
}

export const createRemoteWebGateway = async (
  options: GatewayOptions,
): Promise<RemoteWebGateway> => {
  const allowedOriginUrl = new URL(options.allowedOrigin)
  validatePublicUrl(allowedOriginUrl, '--allowed-origin')
  const allowedOrigin = allowedOriginUrl.origin
  const publicUrl = new URL(options.publicUrl)
  validatePublicUrl(publicUrl)
  const pairingToken = randomBytes(32).toString('hex')
  const pairingExpires = Date.now() + pairingTtl
  const sessions = new Map<string, number>()
  const tickets = new Map<string, number>()
  let pairingAvailable = true

  const setCors = (
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean => {
    if (request.headers.origin !== allowedOrigin) {
      writeJson(response, 403, { error: 'Origin is not allowed' })
      return false
    }
    response.setHeader('access-control-allow-origin', allowedOrigin)
    response.setHeader('vary', 'origin')
    return true
  }

  const server = createServer((request, response) => {
    if (!setCors(request, response)) {
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-max-age': '600',
      })
      response.end()
      return
    }
    if (request.method !== 'POST') {
      writeJson(response, 404, { error: 'Not found' })
      return
    }
    if (request.url === '/auth/pair') {
      const token = getBearerToken(request)
      if (
        !pairingAvailable ||
        Date.now() >= pairingExpires ||
        !tokensEqual(token, pairingToken)
      ) {
        writeJson(response, 401, { error: 'Invalid or expired pairing token' })
        return
      }
      pairingAvailable = false
      const sessionToken = randomBytes(32).toString('hex')
      const sessionExpiresAt = Date.now() + sessionTtl
      sessions.set(sessionToken, sessionExpiresAt)
      writeJson(response, 200, {
        authentication: 'websocket-ticket',
        sessionExpiresAt: new Date(sessionExpiresAt).toISOString(),
        sessionToken,
        websocketUrl: toWebSocketUrl(options.publicUrl),
        workspacePath: options.workspacePath,
      })
      return
    }
    if (request.url === '/auth/websocket-ticket') {
      pruneExpired(sessions)
      pruneExpired(tickets)
      const sessionToken = getBearerToken(request)
      const sessionExpiresAt = sessions.get(sessionToken)
      if (!sessionExpiresAt || Date.now() >= sessionExpiresAt) {
        sessions.delete(sessionToken)
        writeJson(response, 401, { error: 'Invalid session' })
        return
      }
      const ticket = randomBytes(32).toString('hex')
      const expiresAt = Date.now() + ticketTtl
      tickets.set(ticket, expiresAt)
      writeJson(response, 200, {
        expiresAt: new Date(expiresAt).toISOString(),
        ticket,
      })
      return
    }
    writeJson(response, 404, { error: 'Not found' })
  })
  const webSocketServer = new WebSocketServer({
    maxPayload: 64 * 1024 * 1024,
    noServer: true,
  })
  const clients = new Set<WebSocket>()
  const backendKeepAlive = new WebSocket(
    getBackendUrl(options, 'file-system-process'),
  )
  await waitForOpen(backendKeepAlive)
  clients.add(backendKeepAlive)
  backendKeepAlive.once('close', () => clients.delete(backendKeepAlive))
  server.on('upgrade', (request, socket, head) => {
    if (request.headers.origin !== allowedOrigin) {
      rejectUpgrade(socket, '403 Forbidden')
      return
    }
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const match = /^\/websocket\/([^/]+)$/.exec(url.pathname)
    let processType = ''
    try {
      processType = match ? decodeURIComponent(match[1]) : ''
    } catch {
      rejectUpgrade(socket, '400 Bad Request')
      return
    }
    const ticket = url.searchParams.get('ticket') || ''
    const expiresAt = tickets.get(ticket)
    tickets.delete(ticket)
    if (
      !allowedProcesses.has(processType) ||
      !expiresAt ||
      Date.now() >= expiresAt
    ) {
      rejectUpgrade(socket, '401 Unauthorized')
      return
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      clients.add(client)
      const backend = new WebSocket(getBackendUrl(options, processType))
      clients.add(backend)
      const pending: Array<{
        readonly data: Buffer
        readonly isBinary: boolean
      }> = []
      let pendingBytes = 0
      client.on('message', (data, isBinary) => {
        const value = Buffer.from(data as ArrayBuffer)
        if (backend.readyState === WebSocket.OPEN) {
          backend.send(value, { binary: isBinary })
        } else {
          pendingBytes += value.byteLength
          if (pendingBytes > 1024 * 1024) {
            client.close(1009, 'Backend is not ready')
            return
          }
          pending.push({ data: value, isBinary })
        }
      })
      backend.on('open', () => {
        for (const message of pending) {
          backend.send(message.data, { binary: message.isBinary })
        }
        pending.length = 0
        pendingBytes = 0
      })
      backend.on('message', (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data, { binary: isBinary })
        }
      })
      const closeBoth = (): void => {
        client.close()
        backend.close()
      }
      client.on('close', closeBoth)
      backend.on('close', closeBoth)
      client.on('error', closeBoth)
      backend.on('error', closeBoth)
      client.once('close', () => clients.delete(client))
      backend.once('close', () => clients.delete(backend))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine remote web gateway port')
  }
  publicUrl.hash = new URLSearchParams({ token: pairingToken }).toString()
  return {
    close: async () => {
      for (const client of clients) {
        client.terminate()
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
    localPort: address.port,
    pairingUrl: publicUrl.href,
  }
}
