import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RemoteLocation } from '../RemoteSshUri/RemoteSshUri.ts'
import { installServer } from '../ServerInstaller/ServerInstaller.ts'
import { manifest } from '../ServerManifest/ServerManifest.ts'
import * as SshProcessRegistry from '../SshProcessRegistry/SshProcessRegistry.ts'
import * as WorkspaceBackendRpc from '../WorkspaceBackendRpc/WorkspaceBackendRpc.ts'

interface ReadyMessage {
  readonly arch: string
  readonly backend: {
    readonly port: number
    readonly token: string
  }
  readonly capabilities: readonly string[]
  readonly clientVersion: string
  readonly platform: string
  readonly protocolVersion: number
  readonly type: 'ready'
  readonly version: string
}

export interface OpenRequest {
  readonly kind: 'file' | 'folder'
  readonly path: string
}

interface OpenMessage extends OpenRequest {
  readonly type: 'open'
}

type ServerMessage = OpenMessage | ReadyMessage

interface Connection {
  readonly getWorkspaceBackend: () => Promise<WorkspaceBackend>
  readonly invokeBackend: (
    type: string,
    method: string,
    params: readonly unknown[],
  ) => Promise<unknown>
  readonly waitForOpenRequest: () => Promise<OpenRequest>
}

export interface WorkspaceBackend {
  readonly token: string
  readonly url: string
  readonly workspacePath?: string
}

export type InvokeBackend = (
  location: RemoteLocation,
  type: string,
  method: string,
  ...params: readonly unknown[]
) => Promise<unknown>

const installRequiredMarker = '__LVCE_REMOTE_SSH_INSTALL_REQUIRED__'
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
  const configuredBackend = process.env.LVCE_REMOTE_SSH_BACKEND_SCRIPT
  const backendEnvironment = configuredBackend
    ? ` LVCE_REMOTE_SSH_BACKEND_SCRIPT=${escapeShell(configuredBackend)}`
    : ''
  return `root=${root}; runtime="$root/runtimes/${manifest.nodeVersion}/bin/node"; server="$root/servers/${manifest.serverVersion}/lvce-remote-ssh-server.mjs"; if [ -x "$runtime" ] && [ -f "$server" ]; then LVCE_REMOTE_SSH_ROOT="$root" LVCE_REMOTE_SSH_CLIENT_VERSION=${escapeShell(manifest.serverVersion)}${backendEnvironment} exec "$runtime" "$server" connect-or-start; else printf '${installRequiredMarker}\\n'; exit 86; fi`
}

const getControlPath = (location: RemoteLocation): string => {
  const hash = createHash('sha256')
    .update(location.identity)
    .digest('hex')
    .slice(0, 16)
  return path.join(tmpdir(), `lvce-remote-ssh-${process.pid}-${hash}.sock`)
}

const getSshArgs = (
  location: RemoteLocation,
  controlPath = getControlPath(location),
): readonly string[] => {
  return [
    '-M',
    '-S',
    controlPath,
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ControlPersist=no',
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

const getAvailablePort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Failed to allocate a local Remote SSH forwarding port')
  }
  const { port } = address
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

const addForward = async (
  location: RemoteLocation,
  controlPath: string,
  localPort: number,
  remotePort: number,
): Promise<void> => {
  const child = SshProcessRegistry.register(
    spawn(
      sshExecutable,
      [
        '-S',
        controlPath,
        '-O',
        'forward',
        '-o',
        'ExitOnForwardFailure=yes',
        '-L',
        `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
        '--',
        location.target,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  )
  const stderr: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => {
    stderr.push(chunk)
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (code !== 0) {
    throw new Error(
      Buffer.concat(stderr).toString('utf8').trim() ||
        `Failed to forward the remote workspace backend (status ${code})`,
    )
  }
}

class RemoteConnection implements Connection {
  private buffer = ''
  private closed = false
  private isReady = false
  private readonly backendRpcs = new Map<
    string,
    WorkspaceBackendRpc.WorkspaceBackendRpc
  >()
  private readonly child: ChildProcessWithoutNullStreams
  private readonly controlPath: string
  private readonly localPort: number
  private readonly location: RemoteLocation
  private readonly onClose: () => void
  private readonly openRequests: OpenRequest[] = []
  private readonly openRequestWaiters: Array<{
    readonly reject: (error: Error) => void
    readonly resolve: (request: OpenRequest) => void
  }> = []
  private readyReject: (error: Error) => void = () => {}
  private readyResolve: () => void = () => {}
  private readonly ready: Promise<void>
  private readonly readyTimeout: NodeJS.Timeout
  private readonly stderr: Buffer[] = []
  private workspaceBackend: WorkspaceBackend | undefined

  constructor(
    child: ChildProcessWithoutNullStreams,
    location: RemoteLocation,
    controlPath: string,
    localPort: number,
    onClose: () => void,
  ) {
    this.child = child
    this.location = location
    this.controlPath = controlPath
    this.localPort = localPort
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
    for (const rpc of this.backendRpcs.values()) {
      rpc.dispose()
    }
    this.backendRpcs.clear()
    for (const waiter of this.openRequestWaiters) {
      waiter.reject(error)
    }
    this.openRequestWaiters.length = 0
    if (this.isReady) {
      this.onClose()
    }
    void rm(this.controlPath, { force: true })
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
    let value: ServerMessage
    try {
      value = JSON.parse(line) as ServerMessage
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
    if (value.type === 'open') {
      if (
        !this.isReady ||
        (value.kind !== 'file' && value.kind !== 'folder') ||
        typeof value.path !== 'string' ||
        !path.isAbsolute(value.path) ||
        value.path.includes('\0')
      ) {
        this.close(
          new Error('Remote SSH server returned an invalid open request'),
        )
        this.child.kill()
        return
      }
      this.handleOpenRequest({ kind: value.kind, path: value.path })
      return
    }
    if (
      value.type !== 'ready' ||
      value.protocolVersion !== manifest.protocolVersion ||
      value.version !== manifest.serverVersion ||
      value.clientVersion !== manifest.serverVersion ||
      value.platform !== 'linux' ||
      value.arch !== 'x64' ||
      !Array.isArray(value.capabilities) ||
      !value.capabilities.includes('fileSystemProcess') ||
      !value.capabilities.includes('remoteCli') ||
      !value.capabilities.includes('workspaceBackend') ||
      !value.backend ||
      !Number.isSafeInteger(value.backend.port) ||
      typeof value.backend.token !== 'string'
    ) {
      this.close(new Error('Remote SSH server protocol is incompatible'))
      this.child.kill()
      return
    }
    void this.handleReady(value)
  }

  private handleOpenRequest(request: OpenRequest): void {
    const waiter = this.openRequestWaiters.shift()
    if (waiter) {
      waiter.resolve(request)
      return
    }
    this.openRequests.push(request)
  }

  private async handleReady(value: ReadyMessage): Promise<void> {
    try {
      await addForward(
        this.location,
        this.controlPath,
        this.localPort,
        value.backend.port,
      )
      this.workspaceBackend = {
        token: value.backend.token,
        url: `ws://127.0.0.1:${this.localPort}`,
      }
      this.isReady = true
      clearTimeout(this.readyTimeout)
      this.readyResolve()
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
      this.child.kill()
    }
  }

  async waitUntilReady(): Promise<void> {
    await this.ready
  }

  async getWorkspaceBackend(): Promise<WorkspaceBackend> {
    await this.ready
    if (!this.workspaceBackend) {
      throw new Error('Remote workspace backend is unavailable')
    }
    return this.workspaceBackend
  }

  async invokeBackend(
    type: string,
    method: string,
    params: readonly unknown[],
  ): Promise<unknown> {
    await this.ready
    const backend = await this.getWorkspaceBackend()
    let rpc = this.backendRpcs.get(type)
    if (!rpc) {
      const url = new URL(`/websocket/${encodeURIComponent(type)}`, backend.url)
      url.searchParams.set('token', backend.token)
      const createdRpc = WorkspaceBackendRpc.create(url.href, undefined, () => {
        if (this.backendRpcs.get(type) === createdRpc) {
          this.backendRpcs.delete(type)
        }
      })
      rpc = createdRpc
      this.backendRpcs.set(type, rpc)
    }
    try {
      return await rpc.invoke(method, ...params)
    } catch (error) {
      if (this.backendRpcs.get(type) === rpc) {
        this.backendRpcs.delete(type)
      }
      rpc.dispose()
      throw error
    }
  }

  async waitForOpenRequest(): Promise<OpenRequest> {
    await this.ready
    const request = this.openRequests.shift()
    if (request) {
      return request
    }
    return new Promise((resolve, reject) => {
      this.openRequestWaiters.push({ reject, resolve })
    })
  }
}

const spawnConnection = async (
  location: RemoteLocation,
  onClose: () => void,
): Promise<Connection> => {
  const controlPath = getControlPath(location)
  await rm(controlPath, { force: true })
  const localPort = await getAvailablePort()
  const child = SshProcessRegistry.register(
    spawn(sshExecutable, getSshArgs(location, controlPath), {
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  )
  const connection = new RemoteConnection(
    child,
    location,
    controlPath,
    localPort,
    onClose,
  )
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

export const invokeWorkspaceBackend: InvokeBackend = async (
  location,
  type,
  method,
  ...params
) => {
  const connection = await getConnection(location)
  return connection.invokeBackend(type, method, params)
}

export const connectWorkspaceBackend = async (
  location: RemoteLocation,
): Promise<WorkspaceBackend> => {
  const connection = await getConnection(location)
  return connection.getWorkspaceBackend()
}

export const waitForOpenRequest = async (
  location: RemoteLocation,
): Promise<OpenRequest> => {
  const connection = await getConnection(location)
  return connection.waitForOpenRequest()
}

export const _getSshArgs = getSshArgs
export const _getRemoteCommand = getRemoteCommand
export const _resetConnections = (): void => connections.clear()
