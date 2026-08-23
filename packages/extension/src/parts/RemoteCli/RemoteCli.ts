import { executeCommand } from '@lvce-editor/api'
import * as Rpc from '../Rpc/Rpc.ts'

interface OpenRequest {
  readonly kind: 'file' | 'folder'
  readonly uri: string
  readonly workspaceUri: string
}

export type WaitForOpenRequest = (workspaceUri: string) => Promise<unknown>
export type OpenWindow = (url: string) => Promise<unknown>

const watchedWorkspaces = new Set<string>()

const waitForOpenRequest: WaitForOpenRequest = (workspaceUri) => {
  return Rpc.invoke('SshFileSystem.waitForOpenRequest', workspaceUri)
}

const openWindow: OpenWindow = (url) => {
  return executeCommand('ElectronWindow.openNew', url)
}

const parseOpenRequest = (value: unknown): OpenRequest => {
  const request = value as Partial<OpenRequest> | undefined
  if (
    !request ||
    (request.kind !== 'file' && request.kind !== 'folder') ||
    typeof request.uri !== 'string' ||
    !request.uri.startsWith('remote-ssh://') ||
    typeof request.workspaceUri !== 'string' ||
    !request.workspaceUri.startsWith('remote-ssh://')
  ) {
    throw new TypeError('Remote SSH server returned an invalid open request')
  }
  return request as OpenRequest
}

export const getWindowUrl = (request: OpenRequest): string => {
  const searchParams = new URLSearchParams()
  searchParams.set('workspace', request.workspaceUri)
  if (request.kind === 'file') {
    searchParams.set('openUri', request.uri)
  }
  return `/?${searchParams}`
}

const run = async (
  workspaceUri: string,
  wait: WaitForOpenRequest,
  open: OpenWindow,
): Promise<void> => {
  try {
    while (watchedWorkspaces.has(workspaceUri)) {
      const request = parseOpenRequest(await wait(workspaceUri))
      await open(getWindowUrl(request))
    }
  } finally {
    watchedWorkspaces.delete(workspaceUri)
  }
}

export const watch = (
  workspaceUri: string,
  wait: WaitForOpenRequest = waitForOpenRequest,
  open: OpenWindow = openWindow,
): void => {
  if (watchedWorkspaces.has(workspaceUri)) {
    return
  }
  watchedWorkspaces.add(workspaceUri)
  void run(workspaceUri, wait, open).catch(() => {})
}

export const stop = (): void => {
  watchedWorkspaces.clear()
}

export const _reset = stop
