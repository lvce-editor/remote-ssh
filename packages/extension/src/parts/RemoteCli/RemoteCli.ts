import { executeCommand, openUri } from '@lvce-editor/api'
import * as Rpc from '../Rpc/Rpc.ts'
import * as WorkspaceConnection from '../WorkspaceConnection/WorkspaceConnection.ts'

interface OpenRequest {
  readonly kind: 'file' | 'folder'
  readonly uri: string
  readonly workspacePath: string
  readonly workspaceUri: string
}

export type WaitForOpenRequest = (workspaceUri: string) => Promise<unknown>
export type SetWorkspace = (request: OpenRequest) => Promise<unknown>
export type OpenFile = (uri: string) => Promise<unknown>
export type RetryDelay = () => Promise<void>

const watcherTokens = new Map<string, symbol>()

const waitForOpenRequest: WaitForOpenRequest = (workspaceUri) => {
  return Rpc.invoke('SshFileSystem.waitForOpenRequest', workspaceUri)
}

const setWorkspace: SetWorkspace = (request) => {
  return executeCommand('Workspace.setUri', request.workspaceUri, '/', {
    command: WorkspaceConnection.commandId,
    workspacePath: request.workspacePath,
  })
}

const openFile: OpenFile = (uri) => {
  return openUri(uri)
}

const retryDelay: RetryDelay = () => {
  return new Promise((resolve) => setTimeout(resolve, 1000))
}

const parseOpenRequest = (value: unknown): OpenRequest => {
  const request = value as Partial<OpenRequest> | undefined
  if (
    !request ||
    (request.kind !== 'file' && request.kind !== 'folder') ||
    typeof request.uri !== 'string' ||
    !request.uri.startsWith('remote-ssh://') ||
    typeof request.workspacePath !== 'string' ||
    !request.workspacePath.startsWith('/') ||
    typeof request.workspaceUri !== 'string' ||
    !request.workspaceUri.startsWith('remote-ssh://')
  ) {
    throw new TypeError('Remote SSH server returned an invalid open request')
  }
  return request as OpenRequest
}

const run = async (
  workspaceUri: string,
  token: symbol,
  wait: WaitForOpenRequest,
  setCurrentWorkspace: SetWorkspace,
  openCurrentFile: OpenFile,
  waitBeforeRetry: RetryDelay,
): Promise<void> => {
  let currentWorkspaceUri = workspaceUri
  try {
    while (watcherTokens.get(workspaceUri) === token) {
      try {
        const request = parseOpenRequest(await wait(workspaceUri))
        if (watcherTokens.get(workspaceUri) !== token) {
          return
        }
        if (request.workspaceUri !== currentWorkspaceUri) {
          await setCurrentWorkspace(request)
          currentWorkspaceUri = request.workspaceUri
        }
        if (request.kind === 'file') {
          await openCurrentFile(request.uri)
        }
      } catch {
        if (watcherTokens.get(workspaceUri) !== token) {
          return
        }
        await waitBeforeRetry()
      }
    }
  } finally {
    if (watcherTokens.get(workspaceUri) === token) {
      watcherTokens.delete(workspaceUri)
    }
  }
}

export const watch = (
  workspaceUri: string,
  wait: WaitForOpenRequest = waitForOpenRequest,
  setCurrentWorkspace: SetWorkspace = setWorkspace,
  openCurrentFile: OpenFile = openFile,
  waitBeforeRetry: RetryDelay = retryDelay,
): void => {
  if (watcherTokens.has(workspaceUri)) {
    return
  }
  const token = Symbol(workspaceUri)
  watcherTokens.set(workspaceUri, token)
  void run(
    workspaceUri,
    token,
    wait,
    setCurrentWorkspace,
    openCurrentFile,
    waitBeforeRetry,
  ).catch(() => {})
}

export const stop = (): void => {
  watcherTokens.clear()
}

export const _reset = stop
