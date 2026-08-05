import {
  setWorkspaceUri,
  showQuickInput,
  showQuickPick,
} from '@lvce-editor/api'
import * as Rpc from '../Rpc/Rpc.ts'
import * as SshTarget from '../SshTarget/SshTarget.ts'

export const placeholder =
  'Enter SSH host (for example user@example.com or ssh -p 2222 user@example.com)'

export type ShowQuickInput = typeof showQuickInput
export type ShowQuickPick = typeof showQuickPick
export type SetWorkspaceUri = typeof setWorkspaceUri
export type ConnectToHost = (uri: string) => Promise<unknown>
export type GetConfiguredHosts = () => Promise<readonly string[]>
export type Schedule = (callback: () => void) => void

const scheduleAfterCommand: Schedule = (callback) => {
  // Workspace refresh reads this provider, so start it after the originating
  // extension command has returned instead of re-entering the same RPC.
  setTimeout(callback, 0)
}

const connectToHost: ConnectToHost = (uri) => {
  return Rpc.invoke('SshFileSystem.connect', uri)
}

const getConfiguredHosts: GetConfiguredHosts = async () => {
  const hosts = await Rpc.invoke('SshConfigHosts.get')
  if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== 'string')) {
    return []
  }
  return hosts
}

const getConnectionTarget = async (
  showInput: ShowQuickInput,
  showPick: ShowQuickPick,
  getHosts: GetConfiguredHosts,
): Promise<string | undefined> => {
  const hosts = await getHosts()
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
  setUri: SetWorkspaceUri = setWorkspaceUri,
  connectRemote: ConnectToHost = connectToHost,
  schedule: Schedule = scheduleAfterCommand,
  getHosts: GetConfiguredHosts = getConfiguredHosts,
  showPick: ShowQuickPick = showQuickPick,
): Promise<void> => {
  const value = await getConnectionTarget(showInput, showPick, getHosts)
  if (!value || !value.trim()) {
    return
  }
  const workspaceUri = SshTarget.toRemoteSshUri(value)
  await connectRemote(workspaceUri)
  schedule(() => {
    void setUri(workspaceUri)
  })
}
