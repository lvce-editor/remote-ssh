import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer, createConnection, type Socket } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import * as BackendRemoteCli from './parts/BackendRemoteCli/BackendRemoteCli.ts'
import * as RemoteCli from './parts/RemoteCli/RemoteCli.ts'
import { createRemoteWebGateway } from './RemoteWebGateway.ts'

declare const __LVCE_REMOTE_SSH_SERVER_VERSION__: string

const protocolVersion = 1
const serverVersion =
  typeof __LVCE_REMOTE_SSH_SERVER_VERSION__ === 'string'
    ? __LVCE_REMOTE_SSH_SERVER_VERSION__
    : 'dev'
const idleTimeout = Number.parseInt(
  process.env.LVCE_REMOTE_SSH_IDLE_TIMEOUT || String(3 * 60 * 60 * 1000),
)
const root =
  process.env.LVCE_REMOTE_SSH_ROOT || path.join(homedir(), '.lvce-server')
const runDirectory = path.join(root, 'run')
const socketPath = path.join(runDirectory, `server-${serverVersion}.sock`)
const statePath = path.join(runDirectory, `server-${serverVersion}.json`)
const lockPath = path.join(runDirectory, `server-${serverVersion}.lock`)
const logPath = path.join(runDirectory, `server-${serverVersion}.log`)
const clientVersion =
  process.env.LVCE_REMOTE_SSH_CLIENT_VERSION || serverVersion

interface ServerState {
  readonly backendPid: number
  readonly backendPort: number
  readonly backendToken: string
  readonly pid: number
  readonly protocolVersion: number
  readonly socketPath: string
  readonly token: string
  readonly version: string
}

const writeJson = (socket: Socket, value: unknown): void => {
  socket.write(`${JSON.stringify(value)}\n`)
}

const createLineReader = (
  socket: Socket,
  onLine: (line: string) => void,
): (() => void) => {
  let buffer = ''
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8')
    while (true) {
      const index = buffer.indexOf('\n')
      if (index === -1) {
        break
      }
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line) {
        onLine(line)
      }
    }
  }
  socket.on('data', onData)
  return () => socket.off('data', onData)
}

const readState = async (): Promise<ServerState | undefined> => {
  try {
    return JSON.parse(await readFile(statePath, 'utf8')) as ServerState
  } catch {
    return undefined
  }
}

const connectSocket = (state: ServerState): Promise<Socket> => {
  return new Promise((resolve, reject) => {
    const socket = createConnection(state.socketPath)
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
  })
}

const authenticate = async (state: ServerState): Promise<Socket> => {
  const socket = await connectSocket(state)
  socket.write(
    `${JSON.stringify({ clientVersion, token: state.token, type: 'authenticate' })}\n`,
  )
  return socket
}

const isCurrentState = (
  state: ServerState | undefined,
): state is ServerState => {
  return Boolean(
    state &&
    Number.isSafeInteger(state.backendPid) &&
    Number.isSafeInteger(state.backendPort) &&
    typeof state.backendToken === 'string' &&
    state.protocolVersion === protocolVersion &&
    state.version === serverVersion,
  )
}

const waitForServer = async (): Promise<ServerState> => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const state = await readState()
    if (isCurrentState(state)) {
      try {
        const socket = await connectSocket(state)
        socket.destroy()
        return state
      } catch {
        // The state may have been written just before the socket was ready.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Remote SSH server did not start; see ${logPath}`)
}

const getAvailablePort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Failed to allocate the remote workspace backend port')
  }
  const { port } = address
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

const canConnect = async (port: number): Promise<boolean> => {
  try {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = createConnection({ host: '127.0.0.1', port })
      candidate.once('error', reject)
      candidate.once('connect', () => resolve(candidate))
    })
    socket.destroy()
    return true
  } catch {
    return false
  }
}

const stopWorkspaceBackend = (pid: number): void => {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM')
  } catch {
    // The workspace backend may have already stopped.
  }
}

const getBackendScript = (): string => {
  if (process.env.LVCE_REMOTE_SSH_BACKEND_SCRIPT) {
    return process.env.LVCE_REMOTE_SSH_BACKEND_SCRIPT
  }
  return path.join(
    path.dirname(process.argv[1]),
    'lvce-server',
    'node_modules',
    '@lvce-editor',
    'server',
    'src',
    'server.js',
  )
}

const getBuiltinExtensionsPath = async (): Promise<string | undefined> => {
  if (process.env.LVCE_REMOTE_SSH_BUILTIN_EXTENSIONS_PATH) {
    return process.env.LVCE_REMOTE_SSH_BUILTIN_EXTENSIONS_PATH
  }
  const bundledExtensionsPath = path.join(
    path.dirname(process.argv[1]),
    'lvce-server',
    'extensions',
  )
  const bundledExtensionsStat = await stat(bundledExtensionsPath).catch(
    () => undefined,
  )
  if (bundledExtensionsStat?.isDirectory()) {
    return bundledExtensionsPath
  }
  const staticRoot = path.join(
    path.dirname(process.argv[1]),
    'lvce-server',
    'node_modules',
    '@lvce-editor',
    'static-server',
    'static',
  )
  try {
    const entries = await readdir(staticRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const extensionsPath = path.join(staticRoot, entry.name, 'extensions')
      const extensionsStat = await stat(extensionsPath).catch(() => undefined)
      if (extensionsStat?.isDirectory()) {
        return extensionsPath
      }
    }
  } catch {
    // The backend reports a useful error if a built-in node extension is requested later.
  }
  return undefined
}

const startWorkspaceBackend = async (
  log: number,
  cliBinDirectory: string,
): Promise<{
  readonly pid: number
  readonly port: number
  readonly token: string
}> => {
  const port = await getAvailablePort()
  const token = randomBytes(32).toString('hex')
  const builtinExtensionsPath = await getBuiltinExtensionsPath()
  const child = spawn(
    process.execPath,
    [
      getBackendScript(),
      '--as-remote-ssh-server',
      `--port=${port}`,
      `--connection-token=${token}`,
      `--idle-timeout=${idleTimeout}`,
    ],
    {
      detached: true,
      env: {
        ...process.env,
        PATH: `${cliBinDirectory}${path.delimiter}${process.env.PATH || ''}`,
        ...(builtinExtensionsPath
          ? {
              BUILTIN_EXTENSIONS_PATH: builtinExtensionsPath,
              LVCE_REMOTE_EXTENSIONS_PATH: builtinExtensionsPath,
            }
          : {}),
      },
      stdio: ['ignore', log, log],
    },
  )
  child.unref()
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await canConnect(port)) {
      return { pid: child.pid!, port, token }
    }
    if (child.exitCode !== null) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  stopWorkspaceBackend(child.pid!)
  throw new Error(`LVCE remote workspace backend did not start; see ${logPath}`)
}

const acquireLock = async (): Promise<() => Promise<void>> => {
  await mkdir(runDirectory, { recursive: true, mode: 0o700 })
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 })
      return async () => rm(lockPath, { force: true, recursive: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
      const lockStat = await stat(lockPath).catch(() => undefined)
      if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) {
        await rm(lockPath, { force: true, recursive: true })
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

const ensureServer = async (): Promise<ServerState> => {
  const existing = await readState()
  if (isCurrentState(existing)) {
    try {
      const socket = await connectSocket(existing)
      socket.destroy()
      return existing
    } catch {
      // Remove stale state while holding the startup lock below.
    }
  }
  const release = await acquireLock()
  try {
    const raced = await readState()
    if (isCurrentState(raced)) {
      try {
        const socket = await connectSocket(raced)
        socket.destroy()
        return raced
      } catch {
        await rm(statePath, { force: true })
      }
    }
    const log = openSync(logPath, 'a', 0o600)
    const child = spawn(process.execPath, [process.argv[1], 'daemon'], {
      detached: true,
      env: process.env,
      stdio: ['ignore', log, log],
    })
    child.unref()
    closeSync(log)
    await chmod(logPath, 0o600)
    return await waitForServer()
  } finally {
    await release()
  }
}

const connectOrStart = async (): Promise<void> => {
  const state = await ensureServer()
  const socket = await authenticate(state)
  socket.pipe(process.stdout)
  process.stdin.pipe(socket)
  process.stdin.once('end', () => socket.end())
  await new Promise<void>((resolve, reject) => {
    socket.once('close', () => resolve())
    socket.once('error', reject)
  })
}

const runDaemon = async (): Promise<void> => {
  await mkdir(runDirectory, { recursive: true, mode: 0o700 })
  await chmod(runDirectory, 0o700)
  await rm(socketPath, { force: true })
  const token = randomBytes(32).toString('hex')
  const cliBinDirectory = await RemoteCli.prepare(
    root,
    process.execPath,
    process.argv[1],
  )
  const log = openSync(logPath, 'a', 0o600)
  let backend: Awaited<ReturnType<typeof startWorkspaceBackend>>
  try {
    backend = await startWorkspaceBackend(log, cliBinDirectory)
  } catch (error) {
    closeSync(log)
    throw error
  }
  closeSync(log)
  let cliServer: Awaited<ReturnType<typeof RemoteCli.listen>>
  try {
    cliServer = await RemoteCli.listen(root, serverVersion, (request) =>
      BackendRemoteCli.open(backend, request),
    )
  } catch (error) {
    stopWorkspaceBackend(backend.pid)
    throw error
  }
  let connectionCount = 0
  let idleTimer: NodeJS.Timeout | undefined
  const server = createServer((socket) => {
    let authenticated = false
    let stopReading = () => {}
    connectionCount++
    socket.on('error', () => {
      // Authentication and transport errors close only this client socket.
    })
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
    stopReading = createLineReader(socket, (line) => {
      if (!authenticated) {
        try {
          const value = JSON.parse(line) as {
            readonly clientVersion?: string
            readonly token?: string
            readonly type?: string
          }
          if (
            value.type !== 'authenticate' ||
            value.token !== token ||
            typeof value.clientVersion !== 'string'
          ) {
            socket.destroy(new Error('Authentication failed'))
            return
          }
          authenticated = true
          writeJson(socket, {
            arch: process.arch,
            backend: {
              port: state.backendPort,
              token: state.backendToken,
            },
            capabilities: [
              'extensionHostHelperProcess',
              'fileSystemProcess',
              'processExplorer',
              'remoteCli',
              'searchProcess',
              'terminalProcess',
              'workspaceBackend',
            ],
            clientVersion: value.clientVersion,
            platform: process.platform,
            protocolVersion,
            type: 'ready',
            version: serverVersion,
          })
        } catch {
          socket.destroy(new Error('Invalid authentication request'))
        }
        return
      }
      socket.destroy(new Error('Unexpected management protocol message'))
    })
    socket.once('close', () => {
      stopReading()
      connectionCount--
      if (connectionCount === 0) {
        idleTimer = setTimeout(() => server.close(), idleTimeout)
        idleTimer.unref()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })
  await chmod(socketPath, 0o600)
  const state: ServerState = {
    backendPid: backend.pid,
    backendPort: backend.port,
    backendToken: backend.token,
    pid: process.pid,
    protocolVersion,
    socketPath,
    token,
    version: serverVersion,
  }
  const temporaryStatePath = `${statePath}.${process.pid}.tmp`
  await writeFile(temporaryStatePath, JSON.stringify(state), { mode: 0o600 })
  await rename(temporaryStatePath, statePath)
  const cleanup = async (): Promise<void> => {
    const current = await readState()
    if (current?.pid === process.pid) {
      await rm(statePath, { force: true })
    }
    await rm(socketPath, { force: true })
    await RemoteCli.close(cliServer, root, serverVersion)
    stopWorkspaceBackend(backend.pid)
  }
  process.once('SIGTERM', () => server.close())
  process.once('SIGINT', () => server.close())
  await new Promise<void>((resolve) => server.once('close', () => resolve()))
  await cleanup()
}

const getOption = (name: string): string => {
  const prefix = `${name}=`
  const value = process.argv
    .slice(3)
    .findLast((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length)
  if (!value) {
    throw new TypeError(`Remote web server requires ${name}=...`)
  }
  return value
}

const runRemoteWebServer = async (): Promise<void> => {
  const allowedOrigin = getOption('--allowed-origin')
  const publicUrl = getOption('--public-url')
  const workspacePath = getOption('--workspace')
  if (!path.isAbsolute(workspacePath)) {
    throw new TypeError('--workspace must be an absolute path')
  }
  const port = Number.parseInt(getOption('--port'), 10)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('--port must be between 0 and 65535')
  }
  const state = await ensureServer()
  const managementSocket = await authenticate(state)
  const gateway = await createRemoteWebGateway({
    allowedOrigin,
    backendPort: state.backendPort,
    backendToken: state.backendToken,
    port,
    publicUrl,
    workspacePath,
  })
  process.stdout.write(
    `${JSON.stringify({
      localUrl: `http://127.0.0.1:${gateway.localPort}`,
      pairingUrl: gateway.pairingUrl,
      type: 'remote-web-ready',
    })}\n`,
  )
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
  managementSocket.end()
  await gateway.close()
}

const main = async (): Promise<void> => {
  const mode = process.argv[2]
  switch (mode) {
    case 'connect-or-start':
      await connectOrStart()
      return
    case 'cli':
      await RemoteCli.run(root, serverVersion)
      return
    case 'daemon':
      await runDaemon()
      return
    case 'serve-web':
      await runRemoteWebServer()
      return
    case 'version':
      process.stdout.write(
        `${JSON.stringify({ protocolVersion, version: serverVersion })}\n`,
      )
      return
    default:
      throw new Error(`Unknown remote SSH server mode: ${mode || '<missing>'}`)
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  )
  process.exitCode = 1
})
