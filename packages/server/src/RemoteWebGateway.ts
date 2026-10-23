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
const ticketTtl = 60 * 1000
const maxConnections = 32
const maxBufferedBytes = 8 * 1024 * 1024
const allowedProcesses = new Set([
  'extension-node-process',
  'file-system-process',
  'file-watcher-explorer',
  'process-explorer',
  'search-process',
  'shared-process',
  'terminal-process',
])

interface GatewayOptions {
  readonly allowedOrigin: string
  readonly backendPort: number
  readonly backendToken: string
  readonly port: number
  readonly publicUrl: string
  readonly workspacePath: string
  /** Shorter lifetimes can be used by deterministic integration tests. */
  readonly sessionTtl?: number
}

interface Session {
  readonly expiresAt: number
  readonly clients: Set<WebSocket>
  readonly timer: ReturnType<typeof setTimeout>
}

interface Ticket {
  readonly sessionToken: string
  readonly expiresAt: number
  readonly target: string
}

export interface RemoteWebGateway {
  readonly close: () => Promise<void>
  readonly localPort: number
  readonly pairingUrl: string
  readonly pair: () => string
  readonly revoke: () => void
}

const tokensEqual = (actual: string, expected: string): boolean => {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  )
}

const getBearerToken = (request: IncomingMessage): string => {
  const value = request.headers.authorization || ''
  return value.startsWith('Bearer ') ? value.slice(7) : ''
}

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void => {
  const body = JSON.stringify(value)
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

const rejectUpgrade = (socket: Duplex, status: string): void => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`, () =>
    socket.destroy(),
  )
}

const validatePublicUrl = (url: URL, option = '--public-url'): void => {
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TypeError(
      `${option} must use https (or loopback http for development)`,
    )
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new TypeError(
      `${option} must be an origin without credentials, path, query, or fragment`,
    )
  }
}

/** Only these parameters reach the backend, and all are bound into the ticket. */
const getTarget = (type: string, parameters: URLSearchParams): string => {
  if (!allowedProcesses.has(type))
    throw new TypeError('Unsupported workspace process')
  const target = new URL(`/websocket/${type}`, 'http://localhost')
  if (type === 'extension-node-process') {
    for (const name of ['extensionId', 'rpcId']) {
      const value = parameters.get(name)
      if (!value || value.length > 256)
        throw new TypeError('Missing extension process identity')
      target.searchParams.set(name, value)
    }
  }
  return target.pathname + target.search
}

export const createRemoteWebGateway = async (
  options: GatewayOptions,
): Promise<RemoteWebGateway> => {
  const allowedOriginUrl = new URL(options.allowedOrigin)
  validatePublicUrl(allowedOriginUrl, '--allowed-origin')
  const allowedOrigin = allowedOriginUrl.origin
  const publicUrl = new URL(options.publicUrl)
  validatePublicUrl(publicUrl)
  const websocketUrl = new URL(publicUrl)
  websocketUrl.protocol = publicUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  const sessions = new Map<string, Session>()
  const tickets = new Map<string, Ticket>()
  const clients = new Set<WebSocket>()
  let pairingToken = ''
  let pairingExpires = 0
  let attempts = 0
  let attemptWindow = Date.now()

  const pair = (): string => {
    pairingToken = randomBytes(32).toString('hex')
    pairingExpires = Date.now() + pairingTtl
    const url = new URL(publicUrl)
    url.hash = new URLSearchParams({ token: pairingToken }).toString()
    return url.href
  }
  const revokeSession = (token: string): void => {
    const session = sessions.get(token)
    if (!session) return
    clearTimeout(session.timer)
    sessions.delete(token)
    for (const [ticket, value] of tickets) {
      if (value.sessionToken === token) tickets.delete(ticket)
    }
    for (const client of session.clients) client.terminate()
  }
  const revoke = (): void => {
    pairingToken = ''
    for (const token of sessions.keys()) revokeSession(token)
  }
  const allowAttempt = (): boolean => {
    if (Date.now() - attemptWindow >= 60_000) {
      attemptWindow = Date.now()
      attempts = 0
    }
    return ++attempts <= 120
  }
  const getSession = (token: string): Session | undefined => {
    const session = sessions.get(token)
    if (session && Date.now() >= session.expiresAt) {
      revokeSession(token)
      return undefined
    }
    return session
  }
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 },
    (request, response) => {
      if (request.headers.origin !== allowedOrigin) {
        writeJson(response, 403, { error: 'Origin is not allowed' })
        return
      }
      response.setHeader('access-control-allow-origin', allowedOrigin)
      response.setHeader('vary', 'origin')
      if (!allowAttempt()) {
        writeJson(response, 429, {
          error: 'Too many requests; try again in one minute',
        })
        return
      }
      if (
        request.headers['transfer-encoding'] ||
        Number(request.headers['content-length'] || 0) !== 0
      ) {
        response.setHeader('connection', 'close')
        writeJson(response, 413, { error: 'Request bodies are not accepted' })
        return
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-headers': 'authorization, x-lvce-protocol',
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
      let url: URL
      try {
        url = new URL(request.url || '/', publicUrl)
      } catch {
        writeJson(response, 400, { error: 'Invalid request URL' })
        return
      }
      const token = getBearerToken(request)
      if (url.pathname === '/auth/pair') {
        if (request.headers['x-lvce-protocol'] !== '1') {
          writeJson(response, 426, {
            error:
              'Update the LVCE browser connector and remote server (protocol 1 required)',
          })
          return
        }
        if (
          !pairingToken ||
          Date.now() >= pairingExpires ||
          !tokensEqual(token, pairingToken)
        ) {
          writeJson(response, 401, {
            error:
              'Invalid or expired pairing token; generate a new pairing URL',
          })
          return
        }
        pairingToken = ''
        // One active browser session per gateway. Pairing again revokes the previous client.
        for (const previous of sessions.keys()) revokeSession(previous)
        const sessionToken = randomBytes(32).toString('hex')
        const lifetime = options.sessionTtl ?? sessionTtl
        const expiresAt = Date.now() + lifetime
        const timer = setTimeout(() => revokeSession(sessionToken), lifetime)
        timer.unref()
        sessions.set(sessionToken, { clients: new Set(), expiresAt, timer })
        writeJson(response, 200, {
          authentication: 'websocket-ticket',
          capabilities: [...allowedProcesses],
          protocolVersion: 1,
          sessionExpiresAt: new Date(expiresAt).toISOString(),
          sessionToken,
          websocketUrl: websocketUrl.href,
          workspacePath: options.workspacePath,
        })
        return
      }
      const session = getSession(token)
      if (!session) {
        writeJson(response, 401, {
          error: 'Session expired or revoked; pair again',
        })
        return
      }
      if (url.pathname === '/auth/revoke') {
        revokeSession(token)
        writeJson(response, 200, { ok: true })
        return
      }
      if (url.pathname === '/auth/websocket-ticket') {
        for (const [ticket, value] of tickets) {
          if (Date.now() >= value.expiresAt) tickets.delete(ticket)
        }
        if (tickets.size >= 64 || session.clients.size >= maxConnections * 2) {
          writeJson(response, 429, { error: 'Too many workspace connections' })
          return
        }
        let target: string
        try {
          target = getTarget(
            url.searchParams.get('process') || '',
            url.searchParams,
          )
        } catch {
          writeJson(response, 400, { error: 'Invalid workspace process' })
          return
        }
        const ticket = randomBytes(32).toString('hex')
        const expiresAt = Math.min(Date.now() + ticketTtl, session.expiresAt)
        tickets.set(ticket, { expiresAt, sessionToken: token, target })
        writeJson(response, 200, {
          expiresAt: new Date(expiresAt).toISOString(),
          ticket,
        })
        return
      }
      writeJson(response, 404, { error: 'Not found' })
    },
  )
  server.maxConnections = 128
  server.keepAliveTimeout = 5000
  const webSocketServer = new WebSocketServer({
    maxPayload: 8 * 1024 * 1024,
    noServer: true,
  })
  server.on('upgrade', (request, socket, head) => {
    if (request.headers.origin !== allowedOrigin) {
      rejectUpgrade(socket, '403 Forbidden')
      return
    }
    if (!allowAttempt()) {
      rejectUpgrade(socket, '429 Too Many Requests')
      return
    }
    let url: URL
    try {
      url = new URL(request.url || '/', publicUrl)
    } catch {
      rejectUpgrade(socket, '400 Bad Request')
      return
    }
    const ticketKey = url.searchParams.get('ticket') || ''
    const ticket = tickets.get(ticketKey)
    tickets.delete(ticketKey)
    const session = ticket && getSession(ticket.sessionToken)
    let target = ''
    try {
      const match = /^\/websocket\/([a-z-]+)$/.exec(url.pathname)
      if (match) target = getTarget(match[1], url.searchParams)
    } catch {
      // Malformed process identities cannot authorize a connection.
    }
    if (
      !ticket ||
      !session ||
      Date.now() >= ticket.expiresAt ||
      ticket.target !== target
    ) {
      rejectUpgrade(socket, '401 Unauthorized')
      return
    }
    if (session.clients.size >= maxConnections * 2) {
      rejectUpgrade(socket, '429 Too Many Requests')
      return
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      const backendUrl = new URL(
        target,
        `ws://127.0.0.1:${options.backendPort}`,
      )
      backendUrl.searchParams.set('token', options.backendToken)
      const backend = new WebSocket(backendUrl, {
        handshakeTimeout: 10_000,
        maxPayload: 8 * 1024 * 1024,
      })
      for (const connection of [client, backend]) {
        clients.add(connection)
        session.clients.add(connection)
      }
      let disposed = false
      const pending: Array<{
        readonly data: Buffer
        readonly isBinary: boolean
      }> = []
      let pendingBytes = 0
      const closeBoth = (): void => {
        if (disposed) return
        disposed = true
        clearTimeout(openTimeout)
        pending.length = 0
        for (const connection of [client, backend]) {
          clients.delete(connection)
          session.clients.delete(connection)
          connection.terminate()
        }
      }
      const openTimeout = setTimeout(closeBoth, 10_000)
      const send = (
        destination: WebSocket,
        data: Buffer,
        binary: boolean,
      ): void => {
        if (destination.bufferedAmount + data.byteLength > maxBufferedBytes) {
          closeBoth()
          return
        }
        destination.send(data, { binary }, (error) => {
          if (error) closeBoth()
        })
      }
      client.on('message', (data, isBinary) => {
        const value = Buffer.from(data as ArrayBuffer)
        if (backend.readyState === WebSocket.OPEN) {
          send(backend, value, isBinary)
        } else if (pendingBytes + value.byteLength <= maxBufferedBytes) {
          pendingBytes += value.byteLength
          pending.push({ data: value, isBinary })
        } else {
          closeBoth()
        }
      })
      backend.on('open', () => {
        clearTimeout(openTimeout)
        for (const message of pending) {
          if (disposed) break
          send(backend, message.data, message.isBinary)
        }
        pending.length = 0
        pendingBytes = 0
      })
      backend.on('message', (data, isBinary) => {
        const value = Buffer.from(data as ArrayBuffer)
        // Native backends announce readiness outside JSON-RPC. Browser RPC
        // clients start at the WebSocket handshake and accept RPC objects only.
        if (value.byteLength === 7 && value.toString() === '"ready"') return
        if (client.readyState === WebSocket.OPEN) send(client, value, isBinary)
      })
      client.on('close', closeBoth)
      backend.on('close', closeBoth)
      client.on('error', closeBoth)
      backend.on('error', closeBoth)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Failed to determine remote web gateway port')
  return {
    close: async () => {
      revoke()
      for (const client of clients) client.terminate()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      webSocketServer.close()
    },
    localPort: address.port,
    pair,
    pairingUrl: pair(),
    revoke,
  }
}
