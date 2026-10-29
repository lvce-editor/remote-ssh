import { randomBytes } from 'node:crypto'
import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'

interface Grant {
  readonly session: string
  readonly port: number
  readonly protocol: 'http:' | 'https:'
  readonly expiresAt: number
  readonly requests: Set<() => void>
}

// Preview capabilities authorize one loopback service, never the workspace RPC API.
export const createRemoteHttpPreview = (options: {
  readonly publicUrl: URL
  readonly allowedOrigin: string
  readonly validSession: (session: string) => boolean
  readonly blockedPorts: () => readonly number[]
}) => {
  const grants = new Map<string, Grant>()
  const remove = (key: string): void => {
    const grant = grants.get(key)
    grants.delete(key)
    for (const close of grant?.requests || []) close()
  }
  const prune = (): void => {
    for (const [key, grant] of grants) {
      if (grant.expiresAt <= Date.now() || !options.validSession(grant.session))
        remove(key)
    }
  }
  const timer = setInterval(prune, 30_000)
  timer.unref()
  const fail = (
    response: ServerResponse,
    status: number,
    message: string,
  ): void => {
    response.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    })
    response.end(message)
  }
  const getGrant = (key: string): Grant | undefined => {
    const grant = grants.get(key)
    if (
      !grant ||
      grant.expiresAt <= Date.now() ||
      !options.validSession(grant.session)
    ) {
      remove(key)
      return undefined
    }
    return grant
  }
  return {
    create: (session: string, port: number, protocol: string): string => {
      prune()
      if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        options.blockedPorts().includes(port) ||
        !['http:', 'https:'].includes(protocol)
      )
        throw new TypeError('Invalid preview port or protocol')
      if (!options.validSession(session))
        throw new Error('Session expired or revoked')
      for (const [key, grant] of grants) {
        if (
          grant.session === session &&
          grant.port === port &&
          grant.protocol === protocol
        )
          return new URL(`/preview/${key}/`, options.publicUrl).href
      }
      if (
        grants.size >= 64 ||
        [...grants.values()].filter((grant) => grant.session === session)
          .length >= 16
      )
        throw new Error(
          'Too many previews; disconnect and reconnect to clear previews',
        )
      const key = randomBytes(32).toString('hex')
      grants.set(key, {
        session,
        port,
        protocol: protocol as Grant['protocol'],
        expiresAt: Date.now() + 60 * 60 * 1000,
        requests: new Set(),
      })
      return new URL(`/preview/${key}/`, options.publicUrl).href
    },
    revoke: (session: string): void => {
      for (const [key, grant] of grants)
        if (grant.session === session) remove(key)
    },
    close: (): void => {
      clearInterval(timer)
      for (const key of grants.keys()) remove(key)
    },
    handle: (request: IncomingMessage, response: ServerResponse): boolean => {
      const raw = request.url || '/'
      const match = /^\/preview\/([a-f0-9]{64})(\/[^#]*)$/.exec(raw)
      if (!match) {
        if (raw.startsWith('/auth/') || raw.startsWith('/websocket/'))
          return false
        // Root-relative assets/navigation keep the capability through a same-origin
        // redirect. Cross-origin referrers never authorize a preview.
        let referrer: URL | undefined
        try {
          referrer = new URL(request.headers.referer || '')
        } catch {
          /* No preview referrer. */
        }
        const parent =
          referrer?.origin === options.publicUrl.origin &&
          /^\/preview\/([a-f0-9]{64})\//.exec(referrer.pathname)
        if (!parent) return false
        if (!getGrant(parent[1])) {
          fail(
            response,
            401,
            'Preview expired or disconnected. Reopen the terminal link.',
          )
          return true
        }
        if (!raw.startsWith('/') || raw.startsWith('//')) {
          fail(response, 400, 'Invalid preview URL')
          return true
        }
        response.writeHead(307, {
          location: `/preview/${parent[1]}${raw}`,
          'cache-control': 'no-store',
          'referrer-policy': 'same-origin',
        })
        response.end()
        return true
      }
      const [, key, path] = match
      const grant = getGrant(key)
      if (!grant) {
        fail(
          response,
          401,
          'Preview expired or disconnected. Reopen the terminal link.',
        )
        return true
      }
      if (
        !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(
          request.method || '',
        )
      ) {
        fail(response, 405, 'Unsupported preview method')
        return true
      }
      if (grant.requests.size >= 32) {
        fail(response, 429, 'Too many preview requests')
        return true
      }
      const headers = { ...request.headers }
      for (const name of [
        'authorization',
        'cookie',
        'origin',
        'referer',
        'host',
        'connection',
        'upgrade',
        'proxy-authorization',
        'transfer-encoding',
        ...(request.headers.connection || '')
          .toLowerCase()
          .split(',')
          .map((name) => name.trim()),
      ])
        delete headers[name]
      headers.host = `127.0.0.1:${grant.port}`
      const upstream = (
        grant.protocol === 'https:' ? httpsRequest : httpRequest
      )({
        hostname: '127.0.0.1',
        port: grant.port,
        path,
        method: request.method,
        headers,
        timeout: 15_000,
      })
      const close = (): void => {
        upstream.destroy()
        response.destroy()
      }
      grant.requests.add(close)
      response.once('close', () => {
        grant.requests.delete(close)
        upstream.destroy()
      })
      request.once('aborted', close)
      upstream.on('timeout', () =>
        upstream.destroy(new Error('Preview server timed out')),
      )
      upstream.on('error', () => {
        if (response.headersSent) response.destroy()
        else
          fail(
            response,
            502,
            'Remote HTTP server unavailable. Check the port and reopen the terminal link.',
          )
      })
      upstream.on('response', (incoming) => {
        const responseHeaders = { ...incoming.headers }
        for (const name of [
          'connection',
          'transfer-encoding',
          'set-cookie',
          'service-worker-allowed',
          'access-control-allow-origin',
          ...(incoming.headers.connection || '')
            .toLowerCase()
            .split(',')
            .map((name) => name.trim()),
        ])
          delete responseHeaders[name]
        responseHeaders['cache-control'] = 'no-store'
        responseHeaders['referrer-policy'] = 'same-origin'
        // Never let a preview page embed itself in an unrelated website.
        responseHeaders['content-security-policy'] =
          `${incoming.headers['content-security-policy'] || ''}; frame-ancestors ${options.allowedOrigin}`
        if (incoming.headers.location) {
          try {
            const target = new URL(
              incoming.headers.location,
              `${grant.protocol}//127.0.0.1:${grant.port}${path}`,
            )
            if (
              ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) &&
              Number(
                target.port || (target.protocol === 'https:' ? 443 : 80),
              ) === grant.port &&
              target.protocol === grant.protocol
            )
              responseHeaders.location = `/preview/${key}${target.pathname}${target.search}${target.hash}`
          } catch {
            /* Preserve invalid upstream locations for normal browser handling. */
          }
        }
        response.writeHead(incoming.statusCode || 502, responseHeaders)
        incoming.on('error', () => response.destroy())
        incoming.pipe(response)
      })
      let bytes = 0
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > 8 * 1024 * 1024) close()
      })
      request.pipe(upstream)
      return true
    },
  }
}
