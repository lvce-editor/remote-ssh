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
      execute: () => RemoteServerConnect.connect(),
      id: 'remote-server.connect',
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
