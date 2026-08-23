import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net'
import path from 'node:path'

export interface OpenRequest {
  readonly kind: 'file' | 'folder'
  readonly path: string
  readonly type: 'open'
}

interface Response {
  readonly error?: string
  readonly ok?: boolean
}

const maxRequestLength = 64 * 1024

const escapeShell = (value: string): string => {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

const getSocketPath = (root: string, version: string): string => {
  return path.join(root, 'run', `cli-${version}.sock`)
}

const writeJson = (socket: Socket, value: unknown): void => {
  socket.write(`${JSON.stringify(value)}\n`)
}

const readLine = (socket: Socket): Promise<string> => {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const cleanup = (): void => {
      socket.off('close', handleClose)
      socket.off('data', handleData)
      socket.off('error', handleError)
    }
    const handleClose = (): void => {
      cleanup()
      reject(new Error('Remote LVCE CLI connection closed'))
    }
    const handleError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const handleData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      if (buffer.length > maxRequestLength) {
        cleanup()
        reject(new Error('Remote LVCE CLI request is too large'))
        return
      }
      const index = buffer.indexOf('\n')
      if (index === -1) {
        return
      }
      cleanup()
      resolve(buffer.slice(0, index))
    }
    socket.on('close', handleClose)
    socket.on('data', handleData)
    socket.on('error', handleError)
  })
}

const connect = (socketPath: string): Promise<Socket> => {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
  })
}

export const resolveOpenRequest = async (
  args: readonly string[],
  cwd = process.cwd(),
): Promise<OpenRequest> => {
  const invalidOption = args.find((arg) => arg.startsWith('-'))
  if (invalidOption) {
    throw new Error(`Unsupported LVCE CLI option: ${invalidOption}`)
  }
  if (args.length > 1) {
    throw new Error('The remote LVCE CLI accepts one path at a time')
  }
  const requestedPath = args[0] || '.'
  const absolutePath = path.resolve(cwd, requestedPath)
  const fileStat = await stat(absolutePath)
  return {
    kind: fileStat.isDirectory() ? 'folder' : 'file',
    path: absolutePath,
    type: 'open',
  }
}

export const requestOpen = async (
  socketPath: string,
  request: OpenRequest,
): Promise<void> => {
  const socket = await connect(socketPath)
  try {
    writeJson(socket, request)
    const response = JSON.parse(await readLine(socket)) as Response
    if (!response.ok) {
      throw new Error(response.error || 'Remote LVCE CLI request failed')
    }
  } finally {
    socket.end()
  }
}

export const run = async (
  root: string,
  version: string,
  args = process.argv.slice(3),
): Promise<void> => {
  const request = await resolveOpenRequest(args)
  await requestOpen(getSocketPath(root, version), request)
}

export const prepare = async (
  root: string,
  nodePath: string,
  serverPath: string,
): Promise<string> => {
  const binDirectory = path.join(root, 'bin')
  await mkdir(binDirectory, { mode: 0o700, recursive: true })
  const executablePath = path.join(binDirectory, 'lvce')
  const contents = `#!/bin/sh\nLVCE_REMOTE_SSH_ROOT=${escapeShell(root)} exec ${escapeShell(nodePath)} ${escapeShell(serverPath)} cli "$@"\n`
  await writeFile(executablePath, contents, { mode: 0o700 })
  await chmod(executablePath, 0o700)
  return binDirectory
}

const parseRequest = (line: string): OpenRequest => {
  const value = JSON.parse(line) as Partial<OpenRequest>
  if (
    value.type !== 'open' ||
    (value.kind !== 'file' && value.kind !== 'folder') ||
    typeof value.path !== 'string' ||
    !path.isAbsolute(value.path) ||
    value.path.includes('\0')
  ) {
    throw new TypeError('Invalid remote LVCE CLI request')
  }
  return value as OpenRequest
}

export const listen = async (
  root: string,
  version: string,
  handleRequest: (request: OpenRequest) => boolean,
): Promise<Server> => {
  const socketPath = getSocketPath(root, version)
  await mkdir(path.dirname(socketPath), { mode: 0o700, recursive: true })
  await rm(socketPath, { force: true })
  const server = createServer((socket) => {
    void readLine(socket)
      .then((line) => {
        const request = parseRequest(line)
        if (!handleRequest(request)) {
          writeJson(socket, {
            error: 'No local LVCE Editor window is connected to this SSH host',
          })
          return
        }
        writeJson(socket, { ok: true })
      })
      .catch((error) => {
        writeJson(socket, {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => socket.end())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  await chmod(socketPath, 0o600)
  return server
}

export const close = async (
  server: Server,
  root: string,
  version: string,
): Promise<void> => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(getSocketPath(root, version), { force: true })
}

export const _getSocketPath = getSocketPath
