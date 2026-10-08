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
export type StartWorkspaceProgress = (
  message: string,
) => Promise<number | undefined>
export type EndWorkspaceProgress = (id: number) => Promise<void>
export type UpdateWorkspaceProgress = (
  id: number,
  message: string,
) => Promise<void>

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

const startWorkspaceProgress: StartWorkspaceProgress = async (message) => {
  try {
    const id = await executeCommand('Workspace.startProgress', message)
    return typeof id === 'number' ? id : undefined
  } catch {
    return undefined
  }
}

const endWorkspaceProgress: EndWorkspaceProgress = async (id) => {
  try {
    await executeCommand('Workspace.endProgress', id)
  } catch {
    // Progress is optional and must not hide the connection result.
  }
}

const updateWorkspaceProgress: UpdateWorkspaceProgress = async (
  id,
  message,
) => {
  try {
    await executeCommand('Workspace.updateProgress', id, message)
  } catch {
    // Progress is optional and must not hide the connection result.
  }
}

const delay = (milliseconds: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

const connectWithProgress = async (
  uri: string,
  progressId: number | undefined,
  connectRemote: ConnectToHost,
  updateProgress: UpdateWorkspaceProgress,
): Promise<unknown> => {
  if (progressId === undefined) {
    return connectRemote(uri)
  }
  let active = true
  let lastMessage = ''
  const pollProgress = async (): Promise<void> => {
    while (active) {
      try {
        const message = await Rpc.invoke('SshFileSystem.getProgress', uri)
        if (typeof message === 'string' && message && message !== lastMessage) {
          lastMessage = message
          await updateProgress(progressId, message)
        }
      } catch {
        // Older remote-ssh versions do not expose stage updates.
      }
      if (active) {
        await delay(200)
      }
    }
  }
  const polling = pollProgress()
  try {
    return await connectRemote(uri)
  } finally {
    active = false
    await polling
  }
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
  _backend: WorkspaceBackend,
  execute: ExecuteCommand = executeCommand,
): Promise<void> => {
  await execute('Workspace.setUri', workspaceUri)
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
  startProgress: StartWorkspaceProgress = startWorkspaceProgress,
  endProgress: EndWorkspaceProgress = endWorkspaceProgress,
  log: Log = OutputChannel.log,
  updateProgress: UpdateWorkspaceProgress = updateWorkspaceProgress,
): Promise<void> => {
  let progressId: number | undefined
  try {
    progressId = await startProgress(
      'Establishing connection to the Remote SSH host…',
    )
    const startedAt = performance.now()
    await log(`Restoring SSH connection to ${workspaceUri}`)
    const backend = getWorkspaceBackend(
      await connectWithProgress(
        workspaceUri,
        progressId,
        connectRemote,
        updateProgress,
      ),
    )
    if (progressId !== undefined) {
      await updateProgress(progressId, 'Opening Remote SSH workspace…')
    }
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
  } finally {
    if (progressId !== undefined) {
      await endProgress(progressId)
    }
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
  startProgress: StartWorkspaceProgress = startWorkspaceProgress,
  endProgress: EndWorkspaceProgress = endWorkspaceProgress,
  log: Log = OutputChannel.log,
  updateProgress: UpdateWorkspaceProgress = updateWorkspaceProgress,
): Promise<void> => {
  const value = await getConnectionTarget(showInput, showPick, getHosts)
  if (!value || !value.trim()) {
    return
  }
  const startedAt = performance.now()
  let workspaceUri: string
  let backend: WorkspaceBackend
  let progressId: number | undefined
  try {
    workspaceUri = SshTarget.toRemoteSshUri(value)
    progressId = await startProgress(
      'Establishing connection to the Remote SSH host…',
    )
    await log(`Connecting to SSH host ${workspaceUri}`)
    backend = getWorkspaceBackend(
      await connectWithProgress(
        workspaceUri,
        progressId,
        connectRemote,
        updateProgress,
      ),
    )
    if (progressId !== undefined) {
      await updateProgress(progressId, 'Opening Remote SSH workspace…')
    }
  } catch (error) {
    if (progressId !== undefined) {
      await endProgress(progressId)
    }
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
    )
      .catch((error) => reportError(error, notify, log))
      .finally(() => {
        if (progressId !== undefined) {
          return endProgress(progressId)
        }
      })
  })
}
