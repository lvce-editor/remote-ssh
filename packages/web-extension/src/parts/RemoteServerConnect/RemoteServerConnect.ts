import { executeCommand, showQuickInput } from '@lvce-editor/api'
import * as RemoteServerConnection from '../RemoteServerConnection/RemoteServerConnection.ts'

export interface PairingResult {
  readonly authentication: 'websocket-ticket'
  readonly sessionToken: string
  readonly websocketUrl: string
  readonly workspacePath: string
}

export type ShowQuickInput = typeof showQuickInput
export type SetWorkspaceUri = (
  uri: string,
  connection: {
    readonly command: string
    readonly workspacePath: string
  },
) => Promise<void>

const isLoopback = (url: URL): boolean => {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
}

const setWorkspaceUri: SetWorkspaceUri = async (uri, connection) => {
  await executeCommand('Workspace.setUri', uri, connection)
}

const getPairingRequest = (
  value: string,
): { readonly endpoint: URL; readonly token: string } => {
  const endpoint = new URL(value)
  const token = new URLSearchParams(endpoint.hash.slice(1)).get('token') || ''
  endpoint.hash = ''
  const loopback = endpoint.protocol === 'http:' && isLoopback(endpoint)
  if ((endpoint.protocol !== 'https:' && !loopback) || !token) {
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
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(`Remote server pairing failed (${response.status})`)
  }
  const result = (await response.json()) as Partial<PairingResult>
  const webSocketEndpoint = new URL(result.websocketUrl || 'about:blank')
  const isAllowedWebSocket =
    webSocketEndpoint.protocol === 'wss:' ||
    (webSocketEndpoint.protocol === 'ws:' && isLoopback(webSocketEndpoint))
  if (
    result.authentication !== 'websocket-ticket' ||
    typeof result.sessionToken !== 'string' ||
    typeof result.websocketUrl !== 'string' ||
    !isAllowedWebSocket ||
    typeof result.workspacePath !== 'string' ||
    !result.workspacePath.startsWith('/')
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

export const connectWithPairingUrl = async (
  value: string,
  setUri: SetWorkspaceUri = setWorkspaceUri,
  pairServer: (value: string) => Promise<PairingResult> = pair,
): Promise<void> => {
  const result = await pairServer(value)
  RemoteServerConnection.set({
    sessionToken: result.sessionToken,
    websocketUrl: result.websocketUrl,
  })
  await setUri(toWorkspaceUri(result.websocketUrl, result.workspacePath), {
    command: RemoteServerConnection.commandId,
    workspacePath: result.workspacePath,
  })
}
