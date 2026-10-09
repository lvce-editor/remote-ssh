import type {
  WorkspaceProgressData,
  WorkspaceProgressProviderHandle,
} from '@lvce-editor/api'
import {
  executeCommand,
  registerWorkspaceProgressProvider,
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
export type ConnectToHost = (
  uri: string,
  operationId?: number,
) => Promise<unknown>
export type CancelConnection = (
  uri: string,
  operationId: number,
) => Promise<void>
export type IsProgressCancelled = (id: number) => Promise<boolean>
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

const workspaceProgressState: {
  data: WorkspaceProgressData
  operationId: number | undefined
  registration: WorkspaceProgressProviderHandle | undefined
} = {
  data: { message: '', status: 'idle' },
  operationId: undefined,
  registration: undefined,
}

export const registerWorkspaceProgress = (): void => {
  workspaceProgressState.registration = registerWorkspaceProgressProvider({
    getProgressData: () => workspaceProgressState.data,
    id: 'remote-ssh.connection',
  })
}

export const disposeWorkspaceProgress = async (): Promise<void> => {
  workspaceProgressState.operationId = undefined
  workspaceProgressState.data = { message: '', status: 'idle' }
  await workspaceProgressState.registration?.dispose()
  workspaceProgressState.registration = undefined
}

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

const connectToHost: ConnectToHost = (uri, operationId) => {
  return Rpc.invoke('SshFileSystem.connect', uri, operationId)
}

const cancelConnection: CancelConnection = async (uri, operationId) => {
  await Rpc.invoke('SshFileSystem.cancelConnect', uri, operationId)
}

const isProgressCancelled: IsProgressCancelled = async (id) => {
  try {
    return (await executeCommand('Workspace.isProgressCancelled', id)) === true
  } catch {
    return false
  }
}

const startWorkspaceProgress: StartWorkspaceProgress = async (message) => {
  try {
    const id = await executeCommand('Workspace.startProgress', message)
    workspaceProgressState.operationId = typeof id === 'number' ? id : undefined
    workspaceProgressState.data = { message, status: 'in-progress' }
    await workspaceProgressState.registration?.refresh(
      workspaceProgressState.operationId,
    )
    return typeof id === 'number' ? id : undefined
  } catch {
    return undefined
  }
}

const endWorkspaceProgress: EndWorkspaceProgress = async (id) => {
  try {
    if (workspaceProgressState.operationId === id) {
      workspaceProgressState.operationId = undefined
      workspaceProgressState.data = { message: '', status: 'idle' }
      await workspaceProgressState.registration?.refresh(id)
    }
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
    if (workspaceProgressState.operationId === id) {
      workspaceProgressState.data = { message, status: 'in-progress' }
      await workspaceProgressState.registration?.refresh(id)
    }
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
  cancelRemote: CancelConnection,
  isCancelled: IsProgressCancelled,
): Promise<unknown> => {
  if (progressId === undefined) {
    return connectRemote(uri)
  }
  let active = true
  let lastMessage = ''
  const { promise: cancellation, reject: rejectCancellation } =
    Promise.withResolvers<never>()
  const pollProgress = async (): Promise<void> => {
    while (active) {
      try {
        if (await isCancelled(progressId)) {
          active = false
          try {
            await cancelRemote(uri, progressId)
          } catch {
            // Cancellation state still prevents opening the workspace.
          }
          rejectCancellation(new WorkspaceSetupCancelledError())
          return
        }
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
    const value = await Promise.race([
      connectRemote(uri, progressId),
      cancellation,
    ])
    if (await isCancelled(progressId)) {
      try {
        await cancelRemote(uri, progressId)
      } catch {
        // Cancellation state still prevents opening the workspace.
      }
      throw new WorkspaceSetupCancelledError()
    }
    return value
  } finally {
    active = false
    await polling
  }
}

class WorkspaceSetupCancelledError extends Error {
  readonly cancelled = true

  constructor() {
    super('Remote SSH workspace setup was cancelled')
    this.name = 'WorkspaceSetupCancelledError'
  }
}

const isWorkspaceSetupCancelled = (error: unknown): boolean => {
  return error instanceof WorkspaceSetupCancelledError
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
  progressId?: number,
  isCancelled: IsProgressCancelled = isProgressCancelled,
): Promise<void> => {
  await log(`Opening SSH workspace ${workspaceUri}`)
  if (progressId !== undefined && (await isCancelled(progressId))) {
    throw new WorkspaceSetupCancelledError()
  }
  WorkspaceConnection.set(backend)
  watchRemoteCli(workspaceUri)
  if (progressId !== undefined && (await isCancelled(progressId))) {
    return
  }
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
  cancelRemote: CancelConnection = cancelConnection,
  isCancelled: IsProgressCancelled = isProgressCancelled,
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
        cancelRemote,
        isCancelled,
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
      progressId,
      isCancelled,
    )
  } catch (error) {
    if (
      isWorkspaceSetupCancelled(error) ||
      (progressId !== undefined && (await isCancelled(progressId)))
    ) {
      return
    }
    await reportError(error, notify, log)
    throw error
  } finally {
    if (progressId !== undefined) {
      await endProgress(progressId)
    }
  }
}

export const prepare = async (
  workspaceUri: string,
  connectRemote: ConnectToHost = connectToHost,
  watchRemoteCli: WatchRemoteCli = RemoteCli.watch,
  notify: ShowNotification = showNotification,
  startProgress: StartWorkspaceProgress = startWorkspaceProgress,
  endProgress: EndWorkspaceProgress = endWorkspaceProgress,
  log: Log = OutputChannel.log,
  updateProgress: UpdateWorkspaceProgress = updateWorkspaceProgress,
  cancelRemote: CancelConnection = cancelConnection,
  isCancelled: IsProgressCancelled = isProgressCancelled,
): Promise<boolean> => {
  let prepared = false
  await restore(
    workspaceUri,
    async () => {
      prepared = true
    },
    connectRemote,
    watchRemoteCli,
    notify,
    startProgress,
    endProgress,
    log,
    updateProgress,
    cancelRemote,
    isCancelled,
  )
  return prepared
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
  cancelRemote: CancelConnection = cancelConnection,
  isCancelled: IsProgressCancelled = isProgressCancelled,
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
        cancelRemote,
        isCancelled,
      ),
    )
    if (progressId !== undefined) {
      await updateProgress(progressId, 'Opening Remote SSH workspace…')
    }
  } catch (error) {
    const cancelled =
      isWorkspaceSetupCancelled(error) ||
      (progressId !== undefined && (await isCancelled(progressId)))
    if (progressId !== undefined) {
      await endProgress(progressId)
    }
    if (cancelled) {
      return
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
      progressId,
      isCancelled,
    )
      .catch((error) => {
        if (!isWorkspaceSetupCancelled(error)) {
          return reportError(error, notify, log)
        }
      })
      .finally(() => {
        if (progressId !== undefined) {
          return endProgress(progressId)
        }
      })
  })
}
