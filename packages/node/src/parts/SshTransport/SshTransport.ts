import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RemoteLocation } from '../RemoteSshUri/RemoteSshUri.ts'
import * as ConnectionError from '../ConnectionError/ConnectionError.ts'
import { RemoteSshError } from '../RemoteSshError/RemoteSshError.ts'
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
  readonly forwardPort: (
    workspacePath: string,
    remotePort: number,
  ) => Promise<ForwardedPort>
  readonly getForwardedPorts: (
    workspacePath: string,
  ) => Promise<readonly ForwardedPort[]>
  readonly getWorkspaceBackend: () => Promise<WorkspaceBackend>
  readonly invokeBackend: (
    type: string,
    method: string,
    params: readonly unknown[],
  ) => Promise<unknown>
  readonly stopForwardPort: (
    workspacePath: string,
    remotePort: number,
  ) => Promise<void>
  readonly waitForOpenRequest: () => Promise<OpenRequest>
}

export interface ForwardedPort {
  readonly localPort: number
  readonly remotePort: number
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

const connectedMarker = '__LVCE_REMOTE_SSH_CONNECTED__'
const remoteLogPath = `${process.env.LVCE_REMOTE_SSH_REMOTE_ROOT || '$HOME/.lvce-server'}/run/server-${manifest.serverVersion}.log`

const installRequiredMarker = '__LVCE_REMOTE_SSH_INSTALL_REQUIRED__'
const sshExecutable =
  process.platform === 'win32'
    ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
    : '/usr/bin/ssh'

const connections = new Map<string, Promise<Connection>>()
const state = { nextConnectionId: 1 }

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
  return `printf '${connectedMarker}\\n'; root=${root}; runtime="$root/runtimes/${manifest.nodeVersion}/bin/node"; server="$root/servers/${manifest.serverVersion}/lvce-remote-ssh-server.mjs"; if [ -x "$runtime" ] && [ -f "$server" ]; then LVCE_REMOTE_SSH_ROOT="$root" LVCE_REMOTE_SSH_CLIENT_VERSION=${escapeShell(manifest.serverVersion)}${backendEnvironment} exec "$runtime" "$server" connect-or-start; else printf '${installRequiredMarker}\\n'; exit 86; fi`
}

const getControlPath = (location: RemoteLocation): string => {
  const hash = createHash('sha256')
    .update(location.identity)
    .digest('hex')
    .slice(0, 16)
  return path.join(
    tmpdir(),
    `lvce-remote-ssh-${process.pid}-${hash}-${state.nextConnectionId++}.sock`,
  )
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
    // Keep the master in the registered child instead of forking an orphan.
    'ControlPersist=no',
    '-o',
    'ForkAfterAuthentication=no',
    '-o',
    'StdinNull=no',
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

const validatePort = (port: number): void => {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('Remote port must be between 1 and 65535')
  }
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

const runForwardControl = async (
  controlPath: string,
  target: string,
  operation: 'cancel' | 'forward',
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
        operation,
        '-o',
        'ExitOnForwardFailure=yes',
        '-L',
        `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
        '--',
        target,
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
        `Failed to ${operation} Remote SSH port ${remotePort} (status ${code})`,
    )
  }
}

const stopMaster = async (
  controlPath: string,
  target: string,
): Promise<void> => {
  // Failed attempts must not leave the persistent master (and its forwarding ports) alive.
  const child = spawn(
    sshExecutable,
    ['-S', controlPath, '-O', 'exit', '--', target],
    {
      killSignal: 'SIGKILL',
      stdio: 'ignore',
      timeout: 3000,
    },
  )
  await new Promise<void>((resolve) => {
    child.once('error', () => resolve())
    child.once('close', () => resolve())
  })
  await rm(controlPath, { force: true })
}

class RemoteConnection implements Connection {
  private buffer = ''
  private closed = false
  private isReady = false
  private stage: ConnectionError.Stage = 'connect'
  private closeError: Error | undefined
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
  private readonly forwardedPorts = new Map<
    number,
    {
      owners: Set<string>
      readonly forwarding: Promise<ForwardedPort>
      stopping?: Promise<void>
    }
  >()
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

  private close(error: Error, failed = false): void {
    if (this.closed) {
      return
    }
    this.closed = true
    if (
      !(error instanceof InstallRequiredError) &&
      !(error instanceof RemoteSshError)
    ) {
      error = ConnectionError.create(
        this.location.target,
        this.stage,
        error,
        remoteLogPath,
      )
    }
    this.closeError = error
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
    if (failed || !this.isReady) {
      void stopMaster(this.controlPath, this.location.target).catch(() => {})
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
    if (this.closed) {
      return
    }
    if (line === connectedMarker) {
      this.stage = 'start'
      return
    }
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
      this.stage = 'forward'
      await addForward(
        this.location,
        this.controlPath,
        this.localPort,
        value.backend.port,
      )
      if (this.closed) {
        return
      }
      this.workspaceBackend = {
        token: value.backend.token,
        url: `ws://127.0.0.1:${this.localPort}`,
      }
      this.stage = 'session'
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
    if (this.closeError) {
      throw this.closeError
    }
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
      if (this.closeError) {
        throw this.closeError
      }
      if (
        error instanceof RemoteSshError &&
        /^E_REMOTE_BACKEND_(WEBSOCKET|CONNECTION|REQUEST_TIMEOUT|INVALID_RESPONSE)/.test(
          error.code,
        )
      ) {
        if (this.backendRpcs.get(type) === rpc) {
          this.backendRpcs.delete(type)
        }
        rpc.dispose()
        const stderr = Buffer.concat(this.stderr).toString('utf8').trim()
        const detail = stderr
          ? new Error(`${error.message}. SSH: ${stderr}`, { cause: error })
          : error
        const connectionError = ConnectionError.create(
          this.location.target,
          'backend',
          detail,
          remoteLogPath,
        )
        this.close(connectionError, true)
        this.child.kill()
        throw connectionError
      }
      // Missing files and other application errors must not cancel concurrent
      // requests or discard the shared SSH connection.
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

  async forwardPort(
    workspacePath: string,
    remotePort: number,
  ): Promise<ForwardedPort> {
    validatePort(remotePort)
    if (this.closed) {
      throw (
        this.closeError ||
        new Error('Remote SSH workspace connection is closed')
      )
    }
    const existing = this.forwardedPorts.get(remotePort)
    if (existing) {
      if (existing.stopping) {
        await existing.stopping
        return this.forwardPort(workspacePath, remotePort)
      }
      existing.owners.add(workspacePath)
      return existing.forwarding
    }
    const forwarding = (async (): Promise<ForwardedPort> => {
      const localPort = await getAvailablePort()
      await runForwardControl(
        this.controlPath,
        this.location.target,
        'forward',
        localPort,
        remotePort,
      )
      return { localPort, remotePort }
    })()
    const owners = new Set([workspacePath])
    this.forwardedPorts.set(remotePort, { forwarding, owners })
    try {
      return await forwarding
    } catch (error) {
      if (this.forwardedPorts.get(remotePort)?.forwarding === forwarding) {
        this.forwardedPorts.delete(remotePort)
      }
      throw error
    }
  }

  async stopForwardPort(
    workspacePath: string,
    remotePort: number,
  ): Promise<void> {
    const entry = this.forwardedPorts.get(remotePort)
    if (!entry || !entry.owners.has(workspacePath)) {
      return
    }
    if (entry.stopping) {
      await entry.stopping
      return
    }
    if (entry.owners.size > 1) {
      entry.owners.delete(workspacePath)
      return
    }
    const stopping = (async (): Promise<void> => {
      const port = await entry.forwarding
      await runForwardControl(
        this.controlPath,
        this.location.target,
        'cancel',
        port.localPort,
        port.remotePort,
      )
      if (this.forwardedPorts.get(remotePort) === entry) {
        entry.owners.delete(workspacePath)
        this.forwardedPorts.delete(remotePort)
      }
    })()
    entry.stopping = stopping
    try {
      await stopping
    } finally {
      if (entry.stopping === stopping) {
        entry.stopping = undefined
      }
    }
  }

  async getForwardedPorts(
    workspacePath: string,
  ): Promise<readonly ForwardedPort[]> {
    const entries = this.forwardedPorts
      .values()
      .filter((entry) => entry.owners.has(workspacePath))
      .toArray()
    const results = await Promise.allSettled(
      entries.map((entry) => entry.forwarding),
    )
    return results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    )
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
    try {
      await installServer(location)
    } catch (error) {
      throw ConnectionError.create(
        location.target,
        'install',
        error,
        remoteLogPath,
      )
    }
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

export const forwardPort = async (
  location: RemoteLocation,
  remotePort: number,
): Promise<ForwardedPort> => {
  validatePort(remotePort)
  const connection = await getConnection(location)
  return connection.forwardPort(location.path, remotePort)
}

export const stopForwardPort = async (
  location: RemoteLocation,
  remotePort: number,
): Promise<void> => {
  validatePort(remotePort)
  const connection = connections.get(location.identity)
  if (!connection) {
    return
  }
  const activeConnection = await connection
  await activeConnection.stopForwardPort(location.path, remotePort)
}

export const getForwardedPorts = async (
  location: RemoteLocation,
): Promise<readonly ForwardedPort[]> => {
  const connection = connections.get(location.identity)
  if (!connection) {
    return []
  }
  const activeConnection = await connection
  return activeConnection.getForwardedPorts(location.path)
}

export const waitForOpenRequest = async (
  location: RemoteLocation,
): Promise<OpenRequest> => {
  const connection = await getConnection(location)
  return connection.waitForOpenRequest()
}

export const _getSshArgs = getSshArgs
export const _getRemoteCommand = getRemoteCommand
export const _validatePort = validatePort
export const _resetConnections = (): void => connections.clear()
