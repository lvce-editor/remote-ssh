import {
  activate as activateExtensionApi,
  registerCommand,
  executeCommand,
  registerFileSystemProvider,
  showNotification,
  getSecret,
  storeSecret,
  deleteSecret,
} from '@lvce-editor/api'
import * as Benchmark from '../RemoteServerBenchmark/RemoteServerBenchmark.ts'
import * as RemoteServerConnect from '../RemoteServerConnect/RemoteServerConnect.ts'
import * as RemoteServerConnection from '../RemoteServerConnection/RemoteServerConnection.ts'
import * as Transport from '../RemoteServerConnection/RemoteServerTransport.ts'
import { fileSystem } from '../RemoteServerFileSystem/RemoteServerFileSystem.ts'
import * as Session from '../RemoteServerSession/RemoteServerSession.ts'

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
    Session.configure({
      deleteSecret,
      getAccountId: () =>
        executeCommand('Cloudflare.getAccountId') as Promise<string>,
      getSecret,
      storeSecret,
    })
    registerCommand({
      execute: RemoteServerConnect.prepareWorkspace,
      id: 'remote-server.prepareWorkspace',
    })
    registerCommand({
      execute: RemoteServerConnect.connectAccount,
      id: 'remote-server.connectAccount',
    })
    registerCommand({
      execute: RemoteServerConnect.disconnectAccount,
      id: 'remote-server.disconnectAccount',
    })
    registerFileSystemProvider(fileSystem)
    registerFileSystemProvider(Benchmark.reportProvider)
    registerCommand({ execute: Benchmark.run, id: 'remote-server.benchmark' })
    registerCommand({
      execute: () => executeCommand('Cloudflare.openConnections'),
      id: 'remote-server.cloudflare',
    })
    registerCommand({
      execute: async (uri: string) => {
        try {
          await RemoteServerConnection.releaseWorkspace(uri)
        } catch {
          await showNotification(
            'warning',
            'Disconnected locally. Remote revocation failed; run revoke-web on the server.',
          )
        }
      },
      id: 'remote-server.releaseWorkspace',
    })
    registerCommand({
      execute: Transport.connect,
      id: 'remote-server.connectToProcess',
    })
    registerCommand({ execute: Transport.request, id: 'remote-server.request' })
    registerCommand({
      execute: () => RemoteServerConnection.revoke(),
      id: 'remote-server.disconnect',
    })
    registerCommand({
      execute: async () => {
        if (!RemoteServerConnection.getOptions())
          await RemoteServerConnection.restore()
        return showNotification('info', RemoteServerConnection.getStatus())
      },
      id: 'remote-server.status',
    })
    registerCommand({
      execute: (pairingUrl?: string) =>
        pairingUrl
          ? RemoteServerConnect.connectWithPairingUrl(pairingUrl)
          : RemoteServerConnect.connect(),
      id: 'remote-server.connect',
    })
    registerCommand({
      execute: (type: string, params: Readonly<Record<string, string>> = {}) =>
        RemoteServerConnection.getWebSocketUrl(type, params),
      id: RemoteServerConnection.commandId,
    })
  } catch (error) {
    state.activated = false
    throw error
  }
}

export const deactivate = async (): Promise<void> => {
  state.activated = false
  Benchmark.dispose()
  await RemoteServerConnection.dispose()
}
