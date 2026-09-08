import {
  executeCommand,
  showNotification,
  showQuickInput,
  showQuickPick,
} from '@lvce-editor/api'
import * as OutputChannel from '../OutputChannel/OutputChannel.ts'
import * as RemoteCli from '../RemoteCli/RemoteCli.ts'
import * as Rpc from '../Rpc/Rpc.ts'
import * as SshTarget from '../SshTarget/SshTarget.ts'
import * as WorkspaceConnection from '../WorkspaceConnection/WorkspaceConnection.ts'

export const placeholder =
  'Enter SSH host (for example user@example.com or ssh -p 2222 user@example.com)'

export type Log = typeof OutputChannel.log
export type ShowQuickInput = typeof showQuickInput
export type ShowQuickPick = typeof showQuickPick
export type ShowNotification = typeof showNotification
export type SetWorkspaceUri = (
  uri: string,
  backend: WorkspaceBackend,
) => Promise<void>
export type ExecuteCommand = typeof executeCommand
export type ConnectToHost = (uri: string) => Promise<unknown>
export type GetConfiguredHosts = () => Promise<readonly string[]>
export type Schedule = (callback: () => void) => void
export type WatchRemoteCli = (workspaceUri: string) => void

interface WorkspaceBackend {
  readonly token: string
  readonly url: string
  readonly workspacePath: string
}

const scheduleAfterCommand: Schedule = (callback) => {
  // Workspace refresh reads this provider, so start it after the originating
  // extension command has returned instead of re-entering the same RPC.
  setTimeout(callback, 0)
}

const connectToHost: ConnectToHost = (uri) => {
  return Rpc.invoke('SshFileSystem.connect', uri)
}

const getWorkspaceBackend = (value: unknown): WorkspaceBackend => {
  const backend = value as Partial<WorkspaceBackend> | undefined
  if (
    !backend ||
    typeof backend.url !== 'string' ||
    typeof backend.token !== 'string' ||
    typeof backend.workspacePath !== 'string'
  ) {
    throw new TypeError('Remote SSH server did not provide a workspace backend')
  }
  return backend as WorkspaceBackend
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    const code =
      'code' in error && typeof error.code === 'string'
        ? ` (${error.code})`
        : ''
    return `${error.message}${code}`
  }
  return String(error)
}

const reportError = async (
  error: unknown,
  notify: ShowNotification,
  log: Log,
): Promise<void> => {
  const message = `Failed to connect to SSH target: ${getErrorMessage(error)}`
  await log(`ERROR: ${message}`)
  await notify('error', message)
}

export const setRemoteWorkspaceUri = async (
  workspaceUri: string,
  backend: WorkspaceBackend,
  execute: ExecuteCommand = executeCommand,
): Promise<void> => {
  let supportsConnectionCommand = false
  try {
    supportsConnectionCommand =
      (await execute('Workspace.supportsConnectionCommand')) === true
  } catch {
    // Older LVCE hosts require the legacy backend object.
  }
  const connection = supportsConnectionCommand
    ? {
        command: WorkspaceConnection.commandId,
        remoteCliUrl: WorkspaceConnection.getWebSocketUrlForBackend(
          backend,
          'shared-process',
        ),
        webSocketUrl: WorkspaceConnection.getWebSocketUrlForBackend(
          backend,
          'file-system-process',
        ),
        workspacePath: backend.workspacePath,
      }
    : backend
  await execute('Workspace.setUri', workspaceUri, '/', connection)
}

const getConfiguredHosts: GetConfiguredHosts = async () => {
  const hosts = await Rpc.invoke('SshConfigHosts.get')
  if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== 'string')) {
    return []
  }
  return hosts
}

const openWorkspace = async (
  workspaceUri: string,
  backend: WorkspaceBackend,
  startedAt: number,
  setUri: SetWorkspaceUri,
  watchRemoteCli: WatchRemoteCli,
  log: Log,
): Promise<void> => {
  await log(`Opening SSH workspace ${workspaceUri}`)
  WorkspaceConnection.set(backend)
  watchRemoteCli(workspaceUri)
  await setUri(workspaceUri, backend)
  const elapsed = Math.round(performance.now() - startedAt)
  await log(`Connected to SSH workspace ${workspaceUri} in ${elapsed} ms`)
}

export const restore = async (
  workspaceUri: string,
  setUri: SetWorkspaceUri = setRemoteWorkspaceUri,
  connectRemote: ConnectToHost = connectToHost,
  watchRemoteCli: WatchRemoteCli = RemoteCli.watch,
  notify: ShowNotification = showNotification,
  log: Log = OutputChannel.log,
): Promise<void> => {
  const startedAt = performance.now()
  try {
    await log(`Restoring SSH connection to ${workspaceUri}`)
    const backend = getWorkspaceBackend(await connectRemote(workspaceUri))
    await openWorkspace(
      workspaceUri,
      backend,
      startedAt,
      setUri,
      watchRemoteCli,
      log,
    )
  } catch (error) {
    await reportError(error, notify, log)
    throw error
  }
}

const getConnectionTarget = async (
  showInput: ShowQuickInput,
  showPick: ShowQuickPick,
  getHosts: GetConfiguredHosts,
): Promise<string | undefined> => {
  let hosts: readonly string[]
  try {
    hosts = await getHosts()
  } catch {
    return showInput({ placeholder })
  }
  if (hosts.length === 0) {
    return showInput({ placeholder })
  }
  const selected = await showPick({
    acceptInput: true,
    items: hosts.map((host) => ({
      description: 'SSH config',
      label: host,
      value: host,
    })),
    placeholder,
  })
  return typeof selected === 'string' ? selected : undefined
}

export const connect = async (
  showInput: ShowQuickInput = showQuickInput,
  setUri: SetWorkspaceUri = setRemoteWorkspaceUri,
  connectRemote: ConnectToHost = connectToHost,
  schedule: Schedule = scheduleAfterCommand,
  getHosts: GetConfiguredHosts = getConfiguredHosts,
  showPick: ShowQuickPick = showQuickPick,
  watchRemoteCli: WatchRemoteCli = RemoteCli.watch,
  notify: ShowNotification = showNotification,
  log: Log = OutputChannel.log,
): Promise<void> => {
  const value = await getConnectionTarget(showInput, showPick, getHosts)
  if (!value || !value.trim()) {
    return
  }
  const startedAt = performance.now()
  let workspaceUri: string
  let backend: WorkspaceBackend
  try {
    workspaceUri = SshTarget.toRemoteSshUri(value)
    await log(`Connecting to SSH host ${workspaceUri}`)
    backend = getWorkspaceBackend(await connectRemote(workspaceUri))
  } catch (error) {
    await reportError(error, notify, log)
    throw error
  }
  schedule(() => {
    void openWorkspace(
      workspaceUri,
      backend,
      startedAt,
      setUri,
      watchRemoteCli,
      log,
    ).catch((error) => reportError(error, notify, log))
  })
}
