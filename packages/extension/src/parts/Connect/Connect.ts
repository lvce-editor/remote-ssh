import { setWorkspaceUri, showQuickInput } from '@lvce-editor/api'
import * as Rpc from '../Rpc/Rpc.ts'
import * as SshTarget from '../SshTarget/SshTarget.ts'

export const placeholder =
  'Enter SSH host (for example user@example.com or ssh -p 2222 user@example.com)'

export type ShowQuickInput = typeof showQuickInput
export type SetWorkspaceUri = typeof setWorkspaceUri
export type ConnectToHost = (uri: string) => Promise<unknown>
export type Schedule = (callback: () => void) => void

const scheduleAfterCommand: Schedule = (callback) => {
  // Workspace refresh reads this provider, so start it after the originating
  // extension command has returned instead of re-entering the same RPC.
  setTimeout(callback, 0)
}

const connectToHost: ConnectToHost = (uri) => {
  return Rpc.invoke('SshFileSystem.connect', uri)
}

export const connect = async (
  showInput: ShowQuickInput = showQuickInput,
  setUri: SetWorkspaceUri = setWorkspaceUri,
  connectRemote: ConnectToHost = connectToHost,
  schedule: Schedule = scheduleAfterCommand,
): Promise<void> => {
  const value = await showInput({ placeholder })
  if (!value || !value.trim()) {
    return
  }
  const workspaceUri = SshTarget.toRemoteSshUri(value)
  await connectRemote(workspaceUri)
  schedule(() => {
    void setUri(workspaceUri)
  })
}
