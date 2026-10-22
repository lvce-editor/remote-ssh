import { executeCommand, showQuickInput } from '@lvce-editor/api'
import * as RemoteServerConnection from '../RemoteServerConnection/RemoteServerConnection.ts'

export interface PairingResult {
  readonly authentication: 'websocket-ticket'
  readonly capabilities: readonly string[]
  readonly protocolVersion: 1
  readonly sessionExpiresAt: string
  readonly sessionToken: string
  readonly websocketUrl: string
  readonly workspacePath: string
}

export type ShowQuickInput = typeof showQuickInput
export type SetWorkspaceUri = (
  uri: string,
  pathSeparator: string,
  connection: {
    readonly command: string
    readonly workspacePath: string
    readonly disposeCommand: string
  },
) => Promise<void>

const isLoopback = (url: URL): boolean => {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
}

const setWorkspaceUri: SetWorkspaceUri = async (
  uri,
  pathSeparator,
  connection,
) => {
  const opened = await executeCommand(
    'Workspace.setUri',
    uri,
    pathSeparator,
    connection,
  )
  if (opened === false) throw new Error('Remote workspace switch was cancelled')
}

const getPairingRequest = (
  value: string,
): { readonly endpoint: URL; readonly token: string } => {
  const endpoint = new URL(value)
  const token = new URLSearchParams(endpoint.hash.slice(1)).get('token') || ''
  endpoint.hash = ''
  const loopback = endpoint.protocol === 'http:' && isLoopback(endpoint)
  if (
    (endpoint.protocol !== 'https:' && !loopback) ||
    !token ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new TypeError(
      'Pairing URL must use HTTPS and contain a token in its fragment',
    )
  }
  endpoint.pathname = '/auth/pair'
  endpoint.search = ''
  return { endpoint, token }
}

export const pair = async (value: string): Promise<PairingResult> => {
  const { endpoint, token } = getPairingRequest(value)
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${token}`, 'x-lvce-protocol': '1' },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    let hint = 'Check HTTPS ingress, allowed origin, and server availability.'
    if (response.status === 401)
      hint = 'Generate a new pairing URL on the remote server.'
    else if (response.status === 426)
      hint = 'Update the remote server and browser connector.'
    throw new Error(
      `Remote server pairing failed (${response.status}). ${hint}`,
    )
  }
  const result = (await response.json()) as Partial<PairingResult>
  if (
    result.protocolVersion !== 1 ||
    !Array.isArray(result.capabilities) ||
    [
      'file-system-process',
      'terminal-process',
      'search-process',
      'shared-process',
      'extension-node-process',
    ].some((capability) => !result.capabilities?.includes(capability))
  ) {
    throw new TypeError(
      'Remote server protocol or capabilities are incompatible. Update the remote server and browser connector.',
    )
  }
  const webSocketEndpoint = new URL(result.websocketUrl || 'about:blank')
  const isAllowedWebSocket =
    webSocketEndpoint.protocol === 'wss:' ||
    (webSocketEndpoint.protocol === 'ws:' && isLoopback(webSocketEndpoint))
  if (
    webSocketEndpoint.host !== endpoint.host ||
    webSocketEndpoint.protocol !==
      (endpoint.protocol === 'https:' ? 'wss:' : 'ws:') ||
    webSocketEndpoint.username !== '' ||
    webSocketEndpoint.password !== '' ||
    result.authentication !== 'websocket-ticket' ||
    typeof result.sessionToken !== 'string' ||
    typeof result.websocketUrl !== 'string' ||
    webSocketEndpoint.search !== '' ||
    webSocketEndpoint.hash !== '' ||
    !isAllowedWebSocket ||
    typeof result.workspacePath !== 'string' ||
    !result.workspacePath.startsWith('/') ||
    result.sessionToken.length === 0 ||
    typeof result.sessionExpiresAt !== 'string' ||
    !Number.isFinite(Date.parse(result.sessionExpiresAt)) ||
    Date.parse(result.sessionExpiresAt) <= Date.now()
  ) {
    throw new TypeError('Remote server returned an invalid pairing response')
  }
  return result as PairingResult
}

const toWorkspaceUri = (
  websocketUrl: string,
  workspacePath: string,
): string => {
  const endpoint = new URL(websocketUrl)
  const url = new URL(`remote-server://${endpoint.host}`)
  url.pathname = workspacePath
  return url.href
}

export const connect = async (
  showInput: ShowQuickInput = showQuickInput,
  setUri: SetWorkspaceUri = setWorkspaceUri,
  pairServer: (value: string) => Promise<PairingResult> = pair,
): Promise<void> => {
  const value = await showInput({
    placeholder: 'Paste the HTTPS pairing URL from the remote LVCE server',
  })
  if (!value) {
    return
  }
  await connectWithPairingUrl(value, setUri, pairServer)
}

const state = { pairingAttempt: 0 }

export const connectWithPairingUrl = async (
  value: string,
  setUri: SetWorkspaceUri = setWorkspaceUri,
  pairServer: (value: string) => Promise<PairingResult> = pair,
): Promise<void> => {
  const attempt = ++state.pairingAttempt
  const generation = RemoteServerConnection.getGeneration()
  const result = await pairServer(value)
  if (
    attempt !== state.pairingAttempt ||
    generation !== RemoteServerConnection.getGeneration()
  )
    throw new Error(
      'Remote workspace changed while pairing; connect with a new pairing URL',
    )
  const workspaceUri = toWorkspaceUri(result.websocketUrl, result.workspacePath)
  const previous = RemoteServerConnection.getOptions()
  const options = {
    expiresAt: Date.parse(result.sessionExpiresAt),
    sessionToken: result.sessionToken,
    websocketUrl: result.websocketUrl,
    workspaceUri,
  }
  RemoteServerConnection.set(options)
  try {
    await setUri(workspaceUri, '/', {
      command: RemoteServerConnection.commandId,
      disposeCommand: 'remote-server.releaseWorkspace',
      workspacePath: result.workspacePath,
    })
  } catch (error) {
    if (RemoteServerConnection.getOptions() === options) {
      if (previous) RemoteServerConnection.set(previous)
      else await RemoteServerConnection.dispose()
    }
    throw error
  }
}
