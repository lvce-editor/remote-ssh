import { setWorkspaceUri, showQuickInput } from '@lvce-editor/api'

export const placeholder = 'Enter SSH host (for example user@example.com)'
export const workspaceUri = 'remote-ssh:///test-folder'

export type ShowQuickInput = typeof showQuickInput
export type SetWorkspaceUri = typeof setWorkspaceUri
export type Schedule = (callback: () => void) => void

const scheduleAfterCommand: Schedule = (callback) => {
  // Workspace refresh reads this provider, so start it after the originating
  // extension command has returned instead of re-entering the same RPC.
  setTimeout(callback, 0)
}

export const connect = async (
  showInput: ShowQuickInput = showQuickInput,
  setUri: SetWorkspaceUri = setWorkspaceUri,
  schedule: Schedule = scheduleAfterCommand,
): Promise<void> => {
  const value = await showInput({ placeholder })
  if (!value || !value.trim()) {
    return
  }
  schedule(() => {
    void setUri(workspaceUri)
  })
}
