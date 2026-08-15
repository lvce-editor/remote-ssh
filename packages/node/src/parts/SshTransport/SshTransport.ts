import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { RemoteLocation } from '../RemoteSshUri/RemoteSshUri.ts'
import { installServer } from '../ServerInstaller/ServerInstaller.ts'
import { manifest } from '../ServerManifest/ServerManifest.ts'

export interface RemoteRequest {
  readonly content?: string
  readonly newPath?: string
  readonly operation: string
  readonly path: string
}

interface ReadyMessage {
  readonly arch: string
  readonly capabilities: readonly string[]
  readonly clientVersion: string
  readonly platform: string
  readonly protocolVersion: number
  readonly type: 'ready'
  readonly version: string
}

interface RpcResponse {
  readonly error?: {
    readonly code?: number | string
    readonly message: string
  }
  readonly id: number | null
  readonly result?: unknown
}

interface PendingRequest {
  readonly reject: (error: Error) => void
  readonly resolve: (value: unknown) => void
  readonly timeout: NodeJS.Timeout
}

interface Connection {
  readonly invoke: (request: RemoteRequest) => Promise<unknown>
}

export type RunSsh = (
  location: RemoteLocation,
  request: RemoteRequest,
) => Promise<unknown>

const installRequiredMarker = '__LVCE_REMOTE_SSH_INSTALL_REQUIRED__'
const requestTimeout = 120_000
const sshExecutable =
  process.platform === 'win32'
    ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
    : '/usr/bin/ssh'

const connections = new Map<string, Promise<Connection>>()

class InstallRequiredError extends Error {}

const escapeShell = (value: string): string => {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

const getPortArgs = (location: RemoteLocation): readonly string[] => {
  return location.port ? ['-p', location.port] : []
}

const getRemoteCommand = (): string => {
  const configuredRoot = process.env.LVCE_REMOTE_SSH_REMOTE_ROOT
  const root = configuredRoot
    ? escapeShell(configuredRoot)
    : '"$HOME/.lvce-server"'
  return `root=${root}; runtime="$root/runtimes/${manifest.nodeVersion}/bin/node"; server="$root/servers/${manifest.serverVersion}/lvce-remote-ssh-server.mjs"; if [ -x "$runtime" ] && [ -f "$server" ]; then LVCE_REMOTE_SSH_ROOT="$root" LVCE_REMOTE_SSH_CLIENT_VERSION=${escapeShell(manifest.serverVersion)} exec "$runtime" "$server" connect-or-start; else printf '${installRequiredMarker}\\n'; exit 86; fi`
}

const getSshArgs = (location: RemoteLocation): readonly string[] => {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=accept-new',
    ...getPortArgs(location),
    '--',
    location.target,
    getRemoteCommand(),
  ]
}

class RemoteConnection implements Connection {
  private buffer = ''
  private closed = false
  private isReady = false
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly child: ChildProcessWithoutNullStreams
  private readonly onClose: () => void
  private readyReject: (error: Error) => void = () => {}
  private readyResolve: () => void = () => {}
  private readonly ready: Promise<void>
  private readonly readyTimeout: NodeJS.Timeout
  private readonly stderr: Buffer[] = []

  constructor(child: ChildProcessWithoutNullStreams, onClose: () => void) {
    this.child = child
    this.onClose = onClose
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.readyTimeout = setTimeout(() => {
      this.close(new Error('Remote SSH server handshake timed out'))
      child.kill()
    }, 30_000)
    child.stdout.on('data', (chunk: Buffer) => this.handleData(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr.push(chunk)
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') {
        this.close(error)
      }
    })
    child.once('error', (error) => this.close(error))
    child.once('close', (code) => {
      const stderr = Buffer.concat(this.stderr).toString('utf8').trim()
      const suffix = code === null ? '' : ` (status ${code})`
      this.close(new Error(stderr || `Remote SSH connection closed${suffix}`))
    })
  }

  private close(error: Error): void {
    if (this.closed) {
      return
    }
    this.closed = true
    clearTimeout(this.readyTimeout)
    this.readyReject(error)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
    if (this.isReady) {
      this.onClose()
    }
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    while (true) {
      const index = this.buffer.indexOf('\n')
      if (index === -1) {
        return
      }
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line) {
        this.handleLine(line)
      }
    }
  }

  private handleLine(line: string): void {
    if (line === installRequiredMarker) {
      this.close(new InstallRequiredError(installRequiredMarker))
      return
    }
    let value: ReadyMessage | RpcResponse
    try {
      value = JSON.parse(line) as ReadyMessage | RpcResponse
    } catch {
      if (this.isReady) {
        this.close(new Error('Remote SSH server returned invalid JSON'))
        this.child.kill()
      }
      return
    }
    if (!value || typeof value !== 'object') {
      this.close(new Error('Remote SSH server returned an invalid message'))
      this.child.kill()
      return
    }
    if ('type' in value) {
      if (
        value.type !== 'ready' ||
        value.protocolVersion !== manifest.protocolVersion ||
        value.version !== manifest.serverVersion ||
        value.clientVersion !== manifest.serverVersion ||
        value.platform !== 'linux' ||
        value.arch !== 'x64' ||
        !Array.isArray(value.capabilities) ||
        !value.capabilities.includes('fileSystem')
      ) {
        this.close(new Error('Remote SSH server protocol is incompatible'))
        this.child.kill()
        return
      }
      this.isReady = true
      clearTimeout(this.readyTimeout)
      this.readyResolve()
      return
    }
    if (value.id === null) {
      return
    }
    const pending = this.pending.get(value.id)
    if (!pending) {
      return
    }
    clearTimeout(pending.timeout)
    this.pending.delete(value.id)
    if (value.error) {
      const suffix =
        value.error.code === undefined ? '' : ` (${String(value.error.code)})`
      pending.reject(new Error(`${value.error.message}${suffix}`))
    } else {
      pending.resolve(value.result)
    }
  }

  async waitUntilReady(): Promise<void> {
    await this.ready
  }

  async invoke(request: RemoteRequest): Promise<unknown> {
    await this.ready
    if (this.closed) {
      throw new Error('Remote SSH connection is closed')
    }
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Remote SSH operation timed out after 120 seconds'))
      }, requestTimeout)
      this.pending.set(id, { reject, resolve, timeout })
      this.child.stdin.write(
        `${JSON.stringify({ id, method: 'fileSystem', params: request })}\n`,
      )
    })
  }
}

const spawnConnection = async (
  location: RemoteLocation,
  onClose: () => void,
): Promise<Connection> => {
  const child = spawn(sshExecutable, getSshArgs(location), {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const connection = new RemoteConnection(child, onClose)
  await connection.waitUntilReady()
  return connection
}

const createConnection = async (
  location: RemoteLocation,
  onClose: () => void,
): Promise<Connection> => {
  try {
    return await spawnConnection(location, onClose)
  } catch (error) {
    if (!(error instanceof InstallRequiredError)) {
      throw error
    }
    await installServer(location)
    return spawnConnection(location, onClose)
  }
}

const getConnection = (location: RemoteLocation): Promise<Connection> => {
  const existing = connections.get(location.identity)
  if (existing) {
    return existing
  }
  const onClose = (): void => {
    if (connections.get(location.identity) === connection) {
      connections.delete(location.identity)
    }
  }
  const connection = createConnection(location, onClose)
  connections.set(location.identity, connection)
  void connection.catch(() => {
    if (connections.get(location.identity) === connection) {
      connections.delete(location.identity)
    }
  })
  return connection
}

export const runSsh: RunSsh = async (location, request) => {
  const connection = await getConnection(location)
  return connection.invoke(request)
}

export const _getSshArgs = getSshArgs
export const _getRemoteCommand = getRemoteCommand
export const _resetConnections = (): void => connections.clear()
