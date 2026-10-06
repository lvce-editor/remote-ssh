import {
  activate as activateExtensionApi,
  getWorkspaceUri,
  registerCommand,
  registerFileSystemProvider,
  registerPortProvider,
} from '@lvce-editor/api'
import * as Connect from '../Connect/Connect.ts'
import { fileSystem } from '../FileSystem/FileSystem.ts'
import * as ProcessConnection from '../ProcessConnection/ProcessConnection.ts'
import * as RemoteCli from '../RemoteCli/RemoteCli.ts'
import * as Rpc from '../Rpc/Rpc.ts'
import * as WorkspaceConnection from '../WorkspaceConnection/WorkspaceConnection.ts'

const state = {
  activated: false,
  portProviderRegistration: undefined as { dispose: () => void } | undefined,
}

export const activate = async (): Promise<void> => {
  if (state.activated) {
    return
  }
  state.activated = true
  try {
    await activateExtensionApi()
    registerFileSystemProvider(fileSystem)
    state.portProviderRegistration = registerPortProvider({
      async providePorts(workspaceUri) {
        const ports = (await Rpc.invoke(
          'SshWorkspace.getForwardedPorts',
          workspaceUri,
        )) as readonly {
          readonly localPort: number
          readonly remotePort: number
        }[]
        return ports.map(({ localPort, remotePort }) => ({
          active: true,
          forwardedAddress: `localhost:${localPort}`,
          origin: 'Remote SSH',
          port: remotePort,
          runningProcess: '',
        }))
      },
      scheme: 'remote-ssh',
    })
    registerCommand({
      execute: () => Connect.connect(),
      id: 'remote-ssh.connect',
    })
    registerCommand({
      execute: (workspaceUri: string, port: number) =>
        Rpc.invoke('SshWorkspace.forwardPort', workspaceUri, port),
      id: 'remote-ssh.forwardPort',
    })
    registerCommand({
      execute: (workspaceUri: string, port: number) =>
        Rpc.invoke('SshWorkspace.stopForwardPort', workspaceUri, port),
      id: 'remote-ssh.stopForwardPort',
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
    state.portProviderRegistration?.dispose()
    state.portProviderRegistration = undefined
    WorkspaceConnection.reset()
    throw error
  }
}

export const deactivate = async (): Promise<void> => {
  state.activated = false
  state.portProviderRegistration?.dispose()
  state.portProviderRegistration = undefined
  ProcessConnection.dispose()
  RemoteCli.stop()
  WorkspaceConnection.reset()
  await Rpc.dispose()
}
