import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer, createConnection, type Socket } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  execute,
  type RemoteFileSystemRequest,
} from './parts/FileSystem/FileSystem.ts'

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
  readonly pid: number
  readonly protocolVersion: number
  readonly socketPath: string
  readonly token: string
  readonly version: string
}

interface RpcRequest {
  readonly id: number
  readonly method: string
  readonly params: RemoteFileSystemRequest
}

const writeJson = (socket: Socket, value: unknown): void => {
  socket.write(`${JSON.stringify(value)}\n`)
}

const getError = (
  error: unknown,
): { readonly code?: number | string; readonly message: string } => {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).errno
    return {
      ...(code === undefined ? {} : { code }),
      message: error.message,
    }
  }
  return { message: String(error) }
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

const handleRpcLine = async (socket: Socket, line: string): Promise<void> => {
  let request: RpcRequest
  try {
    request = JSON.parse(line) as RpcRequest
    if (
      !Number.isSafeInteger(request.id) ||
      request.method !== 'fileSystem' ||
      !request.params
    ) {
      throw new TypeError('Invalid RPC request')
    }
  } catch (error) {
    writeJson(socket, { error: getError(error), id: null })
    return
  }
  try {
    const result = await execute(request.params)
    writeJson(socket, { id: request.id, result })
  } catch (error) {
    writeJson(socket, { error: getError(error), id: request.id })
  }
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
            capabilities: ['fileSystem'],
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
      void handleRpcLine(socket, line)
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
  }
  process.once('SIGTERM', () => server.close())
  process.once('SIGINT', () => server.close())
  await new Promise<void>((resolve) => server.once('close', () => resolve()))
  await cleanup()
}

const main = async (): Promise<void> => {
  const mode = process.argv[2]
  switch (mode) {
    case 'connect-or-start':
      await connectOrStart()
      return
    case 'daemon':
      await runDaemon()
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
