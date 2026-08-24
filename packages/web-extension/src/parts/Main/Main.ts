import {
  activate as activateExtensionApi,
  registerCommand,
  registerFileSystemProvider,
} from '@lvce-editor/api'
import * as RemoteServerConnect from '../RemoteServerConnect/RemoteServerConnect.ts'
import * as RemoteServerConnection from '../RemoteServerConnection/RemoteServerConnection.ts'
import { fileSystem } from '../RemoteServerFileSystem/RemoteServerFileSystem.ts'

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
      execute: (pairingUrl?: string) =>
        pairingUrl
          ? RemoteServerConnect.connectWithPairingUrl(pairingUrl)
          : RemoteServerConnect.connect(),
      id: 'remote-server.connect',
    })
    registerCommand({
      execute: (type: string) => RemoteServerConnection.getWebSocketUrl(type),
      id: RemoteServerConnection.commandId,
    })
  } catch (error) {
    state.activated = false
    throw error
  }
}

export const deactivate = async (): Promise<void> => {
  state.activated = false
  await RemoteServerConnection.dispose()
}
