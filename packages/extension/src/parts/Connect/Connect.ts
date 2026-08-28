import {
  executeCommand,
  showNotification,
  showQuickInput,
  showQuickPick,
} from '@lvce-editor/api'
import * as RemoteCli from '../RemoteCli/RemoteCli.ts'
import * as Rpc from '../Rpc/Rpc.ts'
import * as SshTarget from '../SshTarget/SshTarget.ts'
import * as WorkspaceConnection from '../WorkspaceConnection/WorkspaceConnection.ts'

export const placeholder =
  'Enter SSH host (for example user@example.com or ssh -p 2222 user@example.com)'

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
    return error.message
  }
  return String(error)
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

export const restore = async (
  workspaceUri: string,
  setUri: SetWorkspaceUri = setRemoteWorkspaceUri,
  connectRemote: ConnectToHost = connectToHost,
  watchRemoteCli: WatchRemoteCli = RemoteCli.watch,
): Promise<void> => {
  const backend = getWorkspaceBackend(await connectRemote(workspaceUri))
  WorkspaceConnection.set(backend)
  watchRemoteCli(workspaceUri)
  await setUri(workspaceUri, backend)
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
): Promise<void> => {
  const value = await getConnectionTarget(showInput, showPick, getHosts)
  if (!value || !value.trim()) {
    return
  }
  let workspaceUri: string
  let backend: WorkspaceBackend
  try {
    workspaceUri = SshTarget.toRemoteSshUri(value)
    backend = getWorkspaceBackend(await connectRemote(workspaceUri))
  } catch (error) {
    await notify(
      'error',
      `Failed to connect to SSH target: ${getErrorMessage(error)}`,
    )
    throw error
  }
  schedule(() => {
    WorkspaceConnection.set(backend)
    watchRemoteCli(workspaceUri)
    void setUri(workspaceUri, backend)
  })
}
