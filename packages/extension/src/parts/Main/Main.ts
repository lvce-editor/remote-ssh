import {
  activate as activateExtensionApi,
  getWorkspaceUri,
  registerCommand,
  registerFileSystemProvider,
} from '@lvce-editor/api'
import * as Connect from '../Connect/Connect.ts'
import { fileSystem } from '../FileSystem/FileSystem.ts'
import * as ProcessConnection from '../ProcessConnection/ProcessConnection.ts'
import * as RemoteCli from '../RemoteCli/RemoteCli.ts'
import * as Rpc from '../Rpc/Rpc.ts'
import * as WorkspaceConnection from '../WorkspaceConnection/WorkspaceConnection.ts'

const state = {
  activated: false,
}

export const activate = async (): Promise<void> => {
  if (state.activated) {
    return
  }
  state.activated = true
  try {
    await activateExtensionApi()
    registerFileSystemProvider(fileSystem)
    registerCommand({
      execute: () => Connect.connect(),
      id: 'remote-ssh.connect',
    })
    registerCommand({
      execute: ProcessConnection.connect,
      id: 'remote-ssh.connectToProcess',
    })
    registerCommand({
      execute: (uri: string, type: string, ...args: readonly unknown[]) =>
        Rpc.invoke('SshWorkspace.request', uri, type, ...args),
      id: 'remote-ssh.request',
    })
    const workspaceUri = await getWorkspaceUri()
    if (
      typeof workspaceUri === 'string' &&
      workspaceUri.startsWith('remote-ssh://')
    ) {
      await Connect.restore(workspaceUri)
    }
  } catch (error) {
    state.activated = false
    WorkspaceConnection.reset()
    throw error
  }
}

export const deactivate = async (): Promise<void> => {
  state.activated = false
  ProcessConnection.dispose()
  RemoteCli.stop()
  WorkspaceConnection.reset()
  await Rpc.dispose()
}
