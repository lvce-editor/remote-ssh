import { executeCommand, openUri } from '@lvce-editor/api'
import * as Rpc from '../Rpc/Rpc.ts'

interface OpenRequest {
  readonly kind: 'file' | 'folder'
  readonly uri: string
  readonly workspaceUri: string
}

export type WaitForOpenRequest = (workspaceUri: string) => Promise<unknown>
export type OpenWindow = (url: string) => Promise<unknown>
export type OpenFile = (uri: string) => Promise<unknown>
export type RetryDelay = () => Promise<void>

const watcherTokens = new Map<string, symbol>()

const waitForOpenRequest: WaitForOpenRequest = (workspaceUri) => {
  return Rpc.invoke('SshFileSystem.waitForOpenRequest', workspaceUri)
}

const openWindow: OpenWindow = (url) => {
  return executeCommand('ElectronWindow.openNew', url)
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
  token: symbol,
  wait: WaitForOpenRequest,
  open: OpenWindow,
  openCurrentFile: OpenFile,
  waitBeforeRetry: RetryDelay,
): Promise<void> => {
  try {
    while (watcherTokens.get(workspaceUri) === token) {
      try {
        const request = parseOpenRequest(await wait(workspaceUri))
        if (watcherTokens.get(workspaceUri) !== token) {
          return
        }
        if (request.kind === 'file' && request.workspaceUri === workspaceUri) {
          await openCurrentFile(request.uri)
        } else {
          await open(getWindowUrl(request))
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
  open: OpenWindow = openWindow,
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
    open,
    openCurrentFile,
    waitBeforeRetry,
  ).catch(() => {})
}

export const stop = (): void => {
  watcherTokens.clear()
}

export const _reset = stop
