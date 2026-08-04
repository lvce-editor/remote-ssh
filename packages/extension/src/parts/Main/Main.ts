import {
  activate as activateExtensionApi,
  registerCommand,
  registerFileSystemProvider,
} from '@lvce-editor/api'
import * as Connect from '../Connect/Connect.ts'
import { fileSystem } from '../FileSystem/FileSystem.ts'
import * as Rpc from '../Rpc/Rpc.ts'

const state = {
  activated: false,
}

export const activate = async (): Promise<void> => {
  if (state.activated) {
    return
  }
  state.activated = true
  await activateExtensionApi()
  registerFileSystemProvider(fileSystem)
  registerCommand({
    execute: () => Connect.connect(),
    id: 'remote-ssh.connect',
  })
}

export const deactivate = async (): Promise<void> => {
  await Rpc.dispose()
}
