import {
  executeCommand,
  showQuickInput,
  showQuickPick,
  showNotification,
} from '@lvce-editor/api'
import * as RemoteServerConnection from '../RemoteServerConnection/RemoteServerConnection.ts'
import * as Session from '../RemoteServerSession/RemoteServerSession.ts'

export interface PairingResult {
  readonly accountId?: string
  readonly authentication: 'websocket-ticket'
  readonly capabilities: readonly string[]
  readonly protocolVersion: 1
  readonly sessionExpiresAt: string | null
  readonly sessionToken: string
  readonly websocketUrl: string
  readonly workspacePath: string
}

const hasValidSessionExpiry = (
  value: string | null | undefined,
  account: boolean,
): boolean =>
  account
    ? value === null
    : typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      Date.parse(value) > Date.now()

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

export const pair = async (
  value: string,
  account = false,
): Promise<PairingResult> => {
  const { endpoint, token } = getPairingRequest(value)
  if (account) endpoint.pathname = '/auth/account'
  let response: Response
  try {
    response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${token}`, 'x-lvce-protocol': '1' },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    // Native DOMExceptions cannot be restored safely across the RPC boundary.
    throw new Error(
      'Could not reach the remote server. Check its HTTPS certificate, allowed origin, and network connection. For a local server, allow device or local network access in the browser and retry.',
    )
  }
  if (!response.ok) {
    let hint = 'Check HTTPS ingress, allowed origin, and server availability.'
    if (response.status === 401)
      hint = account
        ? 'Account authorization expired or was revoked. Connect from your LVCE account again.'
        : 'Generate a new pairing URL on the remote server.'
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
      'file-watcher-explorer',
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
    !hasValidSessionExpiry(result.sessionExpiresAt, account)
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

const getConnectionOptions = (
  result: PairingResult,
  workspaceUri: string,
  account = false,
): RemoteServerConnection.ConnectionOptions => ({
  ...(account && { account: true, accountId: result.accountId }),
  ...(result.sessionExpiresAt && {
    expiresAt: Date.parse(result.sessionExpiresAt),
  }),
  sessionToken: result.sessionToken,
  websocketUrl: result.websocketUrl,
  workspaceUri,
})

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
  account = false,
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
  const options = getConnectionOptions(result, workspaceUri, account)
  RemoteServerConnection.set(options)
  try {
    await setUri(workspaceUri, '/', {
      command: RemoteServerConnection.commandId,
      disposeCommand: 'remote-server.releaseWorkspace',
      workspacePath: result.workspacePath,
    })
    if (RemoteServerConnection.getOptions() === options) {
      try {
        await Session.save(options)
      } catch {
        void showNotification(
          'warning',
          'Connected, but the session could not be saved. Reloading will require a fresh pairing URL.',
        ).catch(() => {})
      }
    }
  } catch (error) {
    if (RemoteServerConnection.getOptions() === options) {
      if (previous) RemoteServerConnection.set(previous)
      else await RemoteServerConnection.dispose()
    }
    throw error
  }
}

interface AccountMachine {
  readonly browserAccess: boolean
  readonly disabled: boolean
  readonly hostname: string
}
export const authorizeAccount = async (
  hostname: string,
  execute: typeof executeCommand = executeCommand,
): Promise<PairingResult> => {
  const grant = (await execute('remote-server.authorizeBrowser', hostname)) as {
    authorization: string
    publicUrl: string
    accountId: string
  }
  const endpoint = new URL(grant.publicUrl)
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.host !== hostname ||
    endpoint.pathname !== '/' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    typeof grant.authorization !== 'string' ||
    typeof grant.accountId !== 'string' ||
    !grant.accountId
  )
    throw new Error('Invalid account authorization response')
  endpoint.hash = new URLSearchParams({ token: grant.authorization }).toString()
  return { ...(await pair(endpoint.href, true)), accountId: grant.accountId }
}
export const connectAccount = async (
  execute: typeof executeCommand = executeCommand,
  showPick: typeof showQuickPick = showQuickPick,
  setUri: SetWorkspaceUri = setWorkspaceUri,
): Promise<void> => {
  const result = (await execute('remote-server.getMachines')) as {
    machines: AccountMachine[]
  }
  const machines = result.machines.filter((machine) => !machine.disabled)
  if (machines.length === 0)
    throw new Error(
      'No remote machines belong to your LVCE account. Run Remote Server: Manage Tunnel Access to approve a machine.',
    )
  let selected = machines[0]
  if (machines.length > 1) {
    const choice = (await showPick({
      items: machines.map((machine) => ({
        description: 'LVCE account',
        label: machine.hostname,
        value: machine.hostname,
      })),
      placeholder: 'Select a remote machine from your LVCE account',
    })) as string | undefined
    selected = machines.find((machine) => machine.hostname === choice)!
    if (!selected) return
  }
  if (!selected.browserAccess)
    throw new Error(
      'Update and restart this remote server to enable account connections.',
    )
  await connectWithPairingUrl(
    '',
    setUri,
    () => authorizeAccount(selected.hostname, execute),
    true,
  )
}

export const prepareWorkspace = async (
  uri: string,
  promptForPairing = true,
  authorize: (hostname: string) => Promise<PairingResult> = authorizeAccount,
): Promise<Parameters<SetWorkspaceUri>[2] | undefined> => {
  if (!RemoteServerConnection.getOptions())
    await RemoteServerConnection.restore()
  await RemoteServerConnection.validateAccountSession()
  if (!RemoteServerConnection.getOptions()) {
    const url = new URL(uri)
    if (
      url.protocol !== 'remote-server:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid remote workspace URI')
    const generation = RemoteServerConnection.getGeneration()
    const attempt = ++state.pairingAttempt
    try {
      const result = await authorize(url.host)
      if (
        generation !== RemoteServerConnection.getGeneration() ||
        attempt !== state.pairingAttempt
      )
        throw new Error('Remote workspace changed while authorizing')
      const options = getConnectionOptions(
        result,
        toWorkspaceUri(result.websocketUrl, result.workspacePath),
        true,
      )
      RemoteServerConnection.set(options)
      await Session.save(options)
    } catch (error) {
      if (
        generation !== RemoteServerConnection.getGeneration() ||
        attempt !== state.pairingAttempt
      )
        throw error
      if (!promptForPairing) throw error
      await connect()
      return undefined
    }
  }
  RemoteServerConnection.assertWorkspace(uri)
  const url = new URL(uri)
  if (url.search || url.hash)
    throw new Error(
      'Remote workspace URI must not contain credentials or parameters',
    )
  return {
    command: RemoteServerConnection.commandId,
    disposeCommand: 'remote-server.releaseWorkspace',
    workspacePath: decodeURIComponent(url.pathname),
  }
}

export const disconnectAccount = async (): Promise<void> => {
  state.pairingAttempt++
  if (!RemoteServerConnection.getOptions())
    await RemoteServerConnection.restore()
  const options = RemoteServerConnection.getOptions()
  if (options?.account) await RemoteServerConnection.revoke()
  else if (!options) await RemoteServerConnection.dispose()
}
