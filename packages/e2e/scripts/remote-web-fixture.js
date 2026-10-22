import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { resolve, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRemoteWebGateway } from '../../server/src/RemoteWebGateway.ts'

const repository = fileURLToPath(new URL('../../..', import.meta.url))
const listen = async (server) => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}
const close = async (server) => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

export const createFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lvce-remote-web-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  await writeFile(
    join(workspace, 'hello.txt'),
    'Hello from the remote machine\n',
  )
  await writeFile(join(workspace, 'example.ts'), 'const count: number = 1\n')
  execFileSync('git', ['init', workspace], { stdio: 'ignore' })
  execFileSync('git', [
    '-C',
    workspace,
    'remote',
    'add',
    'origin',
    'https://github.com/lvce-editor/lvce-editor',
  ])
  const key = join(directory, 'key.pem')
  const cert = join(directory, 'cert.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
  const tls = { key: await readFile(key), cert: await readFile(cert) }
  const frontendRoot = resolve(
    process.env.LVCE_REMOTE_WEB_FRONTEND_DIR || join(repository, 'dist'),
  )
  const prefix = process.env.LVCE_REMOTE_WEB_PATH_PREFIX || ''
  const diagnostics = []
  const sockets = new Set()
  const frontend = createServer(tls, async (request, response) => {
    const pathname = new URL(request.url, 'https://localhost').pathname
    if (!pathname.startsWith(`${prefix}/`)) {
      response.writeHead(404)
      response.end()
      return
    }
    const file = resolve(
      frontendRoot,
      `.${decodeURIComponent(pathname.slice(prefix.length))}${pathname.endsWith('/') ? 'index.html' : ''}`,
    )
    if (!file.startsWith(`${frontendRoot}/`)) {
      response.writeHead(403)
      response.end()
      return
    }
    try {
      const content = await readFile(file)
      const mime =
        {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.json': 'application/json',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.wasm': 'application/wasm',
          '.woff2': 'font/woff2',
        }[extname(file)] || 'application/octet-stream'
      response.writeHead(200, {
        'content-type': mime,
        'cache-control': 'no-store',
      })
      response.end(content)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  const frontendPort = await listen(frontend)
  const origin = `https://localhost:${frontendPort}`
  const backendEntry =
    process.env.LVCE_REMOTE_WEB_BACKEND_SCRIPT ||
    join(
      repository,
      '.tmp',
      'remote-ssh-server',
      'lvce-server',
      'node_modules',
      '@lvce-editor',
      'server',
      'src',
      'server.js',
    )
  const backend = spawn(
    process.execPath,
    [
      backendEntry,
      '--as-remote-ssh-server',
      '--port=0',
      '--connection-token=fixture-backend',
      '--idle-timeout=300000',
    ],
    {
      detached: true,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(directory, 'config'),
        XDG_DATA_HOME: join(directory, 'data'),
        XDG_CACHE_HOME: join(directory, 'cache'),
        XDG_STATE_HOME: join(directory, 'state'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let backendLog = ''
  const backendPort = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Remote backend did not start: ${backendLog}`)),
      30_000,
    )
    backend.stdout.on('data', (data) => {
      backendLog += String(data)
      const match = backendLog.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(Number(match[1]))
      }
    })
    backend.stderr.on('data', (data) => {
      backendLog += String(data)
    })
    backend.once('error', reject)
    backend.once('exit', () => {
      clearTimeout(timeout)
      reject(new Error(`Remote backend exited: ${backendLog}`))
    })
  })
  let gateway
  const ingress = createServer(tls, (request, response) => {
    response.once('finish', () =>
      diagnostics.push({
        method: request.method,
        path: new URL(request.url, 'https://localhost').pathname,
        status: response.statusCode,
      }),
    )
    const upstream = httpRequest(
      {
        hostname: '127.0.0.1',
        port: gateway.localPort,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (reply) => {
        response.writeHead(reply.statusCode, reply.headers)
        reply.pipe(response)
      },
    )
    upstream.on('error', () => {
      response.writeHead(502)
      response.end()
    })
    request.pipe(upstream)
  })
  ingress.on('upgrade', (request, socket, head) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: gateway.localPort,
      path: request.url,
      headers: request.headers,
    })
    upstream.on('upgrade', (reply, connection, upstreamHead) => {
      sockets.add(connection)
      connection.on('close', () => sockets.delete(connection))
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join('\r\n')}\r\n\r\n`,
      )
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) connection.write(head)
      socket.pipe(connection).pipe(socket)
      socket.on('error', () => connection.destroy())
      connection.on('error', () => socket.destroy())
    })
    upstream.on('response', (reply) => {
      socket.end(
        `HTTP/1.1 ${reply.statusCode} Rejected\r\nConnection: close\r\n\r\n`,
      )
      reply.resume()
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })
  const ingressPort = await listen(ingress)
  gateway = await createRemoteWebGateway({
    allowedOrigin: origin,
    backendPort,
    backendToken: 'fixture-backend',
    port: 0,
    publicUrl: `https://localhost:${ingressPort}`,
    workspacePath: workspace,
  })
  return {
    gateway,
    diagnostics,
    directory,
    url: `${origin}${prefix}/`,
    workspace,
    async dispose() {
      await gateway.close()
      for (const socket of sockets) socket.destroy()
      await close(ingress)
      await close(frontend)
      try {
        process.kill(-backend.pid, 'SIGTERM')
      } catch {
        backend.kill()
      }
      if (backend.exitCode === null) await once(backend, 'exit')
      await rm(directory, { force: true, recursive: true })
    },
  }
}
