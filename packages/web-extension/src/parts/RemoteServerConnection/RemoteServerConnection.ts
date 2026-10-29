import * as ContainerWorkspace from '../ContainerWorkspace/ContainerWorkspace.ts'
import { RemoteServerError } from '../RemoteServerError/RemoteServerError.ts'
import * as Session from '../RemoteServerSession/RemoteServerSession.ts'
import { revokePreviews } from './RemoteHttpPreview.ts'

export interface ConnectionOptions {
  readonly account?: boolean
  readonly accountId?: string
  readonly expiresAt?: number
  readonly hostWorkspaceUri?: string
  readonly sessionToken: string
  readonly websocketUrl: string
  readonly workspaceUri?: string
}

export const commandId = 'remote-server.getWebSocketUrl'

interface RpcError {
  readonly code?: number | string
  readonly data?: { readonly code?: number | string }
  readonly message?: string
}

interface RpcResponse {
  readonly error?: RpcError
  readonly id?: number
  readonly result?: unknown
}

interface PendingRequest {
  readonly reject: (error: Error) => void
  readonly resolve: (value: unknown) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

interface Rpc {
  readonly close: () => void
  readonly invoke: (
    method: string,
    ...params: readonly unknown[]
  ) => Promise<unknown>
}

const state: {
  authorizationController: AbortController
  expiryTimer: ReturnType<typeof setTimeout> | undefined
  generation: number
  options: ConnectionOptions | undefined
  rpcs: Map<string, Promise<Rpc>>
  restoration: Promise<void> | undefined
} = {
  authorizationController: new AbortController(),
  expiryTimer: undefined,
  generation: 0,
  options: undefined,
  restoration: undefined,
  rpcs: new Map(),
}

const getWebSocketErrorDetail = (event: unknown): string => {
  if (!event || typeof event !== 'object') {
    return ''
  }
  if ('error' in event && event.error instanceof Error && event.error.message) {
    return event.error.message
  }
  if ('message' in event && typeof event.message === 'string') {
    return event.message
  }
  return ''
}

const getWebSocketCloseDetail = (event: unknown): string => {
  if (!event || typeof event !== 'object') {
    return ''
  }
  const code =
    'code' in event && typeof event.code === 'number' ? event.code : undefined
  const reason =
    'reason' in event && typeof event.reason === 'string'
      ? event.reason.trim()
      : ''
  if (code !== undefined && reason) {
    return ` (close code ${code}: ${reason})`
  }
  if (code === 1006) {
    return ' (close code 1006: the network connection was lost without a close frame)'
  }
  if (code !== undefined) {
    return ` (close code ${code})`
  }
  return reason ? ` (${reason})` : ''
}

const getErrorDetail = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error)
  }
  if (error.cause instanceof Error) {
    return error.cause.message
  }
  return error.message
}

const getHttpErrorHint = (status: number): string => {
  if (status === 401)
    return ' Session expired or revoked; generate a new pairing URL.'
  if (status === 429) return ' Too many requests; wait one minute and retry.'
  if (status === 404) {
    return ' The remote server does not provide the WebSocket ticket endpoint.'
  }
  if (status >= 500) {
    return ' The remote server is temporarily unavailable.'
  }
  return ''
}

const toError = (value: RpcError | undefined): Error => {
  const code = value?.data?.code ?? value?.code
  return new RemoteServerError(
    value?.message || 'Remote server request failed',
    typeof code === 'string' || typeof code === 'number'
      ? String(code)
      : 'E_REMOTE_SERVER_REQUEST_FAILED',
  )
}

const getTicket = async (
  options: ConnectionOptions,
  type: string,
  params: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<string> => {
  const endpoint = new URL('/auth/websocket-ticket', options.websocketUrl)
  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:'
  endpoint.searchParams.set('process', type)
  for (const [key, value] of Object.entries(params))
    endpoint.searchParams.set(key, value)
  let response: Response
  try {
    response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${options.sessionToken}` },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        state.authorizationController.signal,
        AbortSignal.timeout(15_000),
      ]),
    })
  } catch (error) {
    const detail = getErrorDetail(error)
    throw new RemoteServerError(
      `Failed to authorize the remote WebSocket: ${detail}.`,
      'E_REMOTE_SERVER_WEBSOCKET_AUTH_NETWORK_ERROR',
      error,
    )
  }
  if (!response.ok) {
    if (response.status === 401 && state.options === options) {
      try {
        await invalidate()
      } catch {
        /* Preserve the authentication error if storage is unavailable. */
      }
    }
    const statusText = response.statusText ? ` ${response.statusText}` : ''
    const hint = getHttpErrorHint(response.status)
    throw new RemoteServerError(
      `Failed to authorize the remote WebSocket: HTTP ${response.status}${statusText}.${hint}`,
      'E_REMOTE_SERVER_WEBSOCKET_AUTH_HTTP_ERROR',
    )
  }
  const result = (await response.json()) as { readonly ticket?: unknown }
  if (typeof result.ticket !== 'string') {
    throw new RemoteServerError(
      'Remote server returned an invalid WebSocket ticket',
      'E_REMOTE_SERVER_WEBSOCKET_AUTH_INVALID_RESPONSE',
    )
  }
  return result.ticket
}

const createWebSocketUrl = async (
  options: ConnectionOptions,
  type: string,
  params: Readonly<Record<string, string>> = {},
  signal?: AbortSignal,
): Promise<string> => {
  const container =
    options.workspaceUri &&
    ContainerWorkspace.getContainer(options.workspaceUri)
  if (container) params = { ...params, container }
  const { generation } = state
  const url = new URL(
    `/websocket/${encodeURIComponent(type)}`,
    options.websocketUrl,
  )
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value)
  url.searchParams.set('ticket', await getTicket(options, type, params, signal))
  if (state.options !== options || state.generation !== generation)
    throw new Error('Remote workspace changed while authorizing')
  return url.href
}

const createRpc = async (
  options: ConnectionOptions,
  generation: number,
  type: string,
  signal?: AbortSignal,
): Promise<Rpc> => {
  const url = await createWebSocketUrl(options, type, {}, signal)
  signal?.throwIfAborted()
  const webSocket = new WebSocket(url)
  const pending = new Map<number, PendingRequest>()
  const disposeConnection = (): void => {
    close()
    webSocket.close()
  }
  connections.add(disposeConnection)
  let nextId = 1
  let closed = false
  const { promise: ready, reject, resolve } = Promise.withResolvers<void>()

  const close = (
    error = new RemoteServerError(
      'Remote server connection closed',
      'E_REMOTE_SERVER_CONNECTION_CLOSED',
    ),
  ): void => {
    if (closed) {
      return
    }
    closed = true
    connections.delete(disposeConnection)
    signal?.removeEventListener('abort', disposeConnection)
    clearTimeout(openTimeout)
    webSocket.close()
    reject(error)
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    pending.clear()
    if (!signal && state.generation === generation) {
      state.rpcs.delete(type)
    }
  }

  const openTimeout = setTimeout(
    () =>
      close(
        new RemoteServerError(
          'Remote connection timed out',
          'E_REMOTE_SERVER_CONNECT_TIMEOUT',
        ),
      ),
    30_000,
  )
  signal?.addEventListener('abort', disposeConnection, { once: true })
  if (signal?.aborted) disposeConnection()
  void ready.catch(() => {})
  webSocket.onopen = (): void => {
    clearTimeout(openTimeout)
    resolve()
  }
  webSocket.onerror = (event): void => {
    const detail = getWebSocketErrorDetail(event)
    const suffix = detail ? `: ${detail}` : ''
    close(
      new RemoteServerError(
        `Remote server WebSocket failed${suffix}`,
        'E_REMOTE_SERVER_WEBSOCKET_ERROR',
      ),
    )
  }
  webSocket.onclose = (event): void =>
    close(
      new RemoteServerError(
        `Remote server WebSocket closed${getWebSocketCloseDetail(event)}`,
        'E_REMOTE_SERVER_WEBSOCKET_CLOSED',
      ),
    )
  webSocket.onmessage = (event): void => {
    try {
      const value: unknown = JSON.parse(String(event.data))
      if (value === 'ready') return
      const response = value as RpcResponse
      if (!Number.isSafeInteger(response.id)) {
        throw new TypeError('Remote server returned invalid JSON-RPC')
      }
      const request = pending.get(response.id!)
      if (!request) {
        return
      }
      clearTimeout(request.timeout)
      pending.delete(response.id!)
      if (response.error) {
        request.reject(toError(response.error))
      } else {
        request.resolve(response.result)
      }
    } catch (error) {
      close(
        new RemoteServerError(
          error instanceof Error ? error.message : String(error),
          'E_REMOTE_SERVER_INVALID_RESPONSE',
          error,
        ),
      )
      webSocket.close()
    }
  }

  return {
    close: (): void => {
      close()
      webSocket.close()
    },
    invoke: async (method, ...params): Promise<unknown> => {
      await ready
      if (closed) {
        throw new RemoteServerError(
          'Remote server connection is closed',
          'E_REMOTE_SERVER_CONNECTION_CLOSED',
        )
      }
      if (pending.size >= 256 || webSocket.bufferedAmount > 1024 * 1024)
        throw new Error('Remote request queue is full')
      const id = nextId++
      return new Promise((resolveRequest, rejectRequest) => {
        const timeout = setTimeout(() => {
          pending.delete(id)
          rejectRequest(
            new RemoteServerError(
              'Remote server request timed out',
              'E_REMOTE_SERVER_REQUEST_TIMEOUT',
            ),
          )
        }, 120_000)
        pending.set(id, {
          reject: rejectRequest,
          resolve: resolveRequest,
          timeout,
        })
        try {
          webSocket.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }))
        } catch {
          clearTimeout(timeout)
          pending.delete(id)
          rejectRequest(
            new Error('Remote request could not be sent; it was not retried'),
          )
        }
      })
    },
  }
}

const connections = new Set<() => void>()

export const set = (options: ConnectionOptions): void => {
  state.authorizationController.abort()
  state.authorizationController = new AbortController()
  clearTimeout(state.expiryTimer)
  if (options.expiresAt)
    state.expiryTimer = setTimeout(
      () => {
        void invalidate().catch(() => {})
      },
      Math.max(0, options.expiresAt - Date.now()),
    )
  for (const close of connections) close()
  state.generation++
  state.options = options
  state.rpcs.clear()
}

export const dispose = async (): Promise<void> => {
  state.authorizationController.abort()
  clearTimeout(state.expiryTimer)
  state.expiryTimer = undefined
  state.generation++
  state.options = undefined
  for (const close of connections) close()
  state.rpcs.clear()
}

const invalidate = async (): Promise<void> => {
  const clearing = Session.clear()
  await dispose()
  await clearing
}

const restoreSession = async (generation: number): Promise<void> => {
  try {
    const options = await Session.load()
    if (options && generation === state.generation && !state.options)
      set(options)
  } finally {
    state.restoration = undefined
  }
}
export const restore = (): Promise<void> => {
  if (state.options) return Promise.resolve()
  if (!state.restoration) state.restoration = restoreSession(state.generation)
  return state.restoration
}

export const assertWorkspace = (uri: string): void => {
  if (!state.options)
    throw new Error(
      'Remote server is not paired; connect with a new pairing URL',
    )
  const actual = new URL(uri)
  if (
    actual.protocol !== 'remote-server:' ||
    actual.host !==
      new URL(state.options.workspaceUri || state.options.websocketUrl).host ||
    actual.username ||
    actual.password ||
    ContainerWorkspace.getContainer(uri) !==
      (state.options.workspaceUri
        ? ContainerWorkspace.getContainer(state.options.workspaceUri)
        : '')
  ) {
    throw new Error('Remote resource belongs to a different server')
  }
}

export const getStatus = (): string =>
  state.options
    ? `Paired with ${new URL(state.options.websocketUrl).host}`
    : 'Disconnected; connect with a new pairing URL'

export const revoke = async (): Promise<void> => {
  if (!state.options) {
    try {
      await restore()
    } catch {
      /* Disconnect remains available without browser storage. */
    }
  }
  const { options } = state
  try {
    await invalidate()
  } catch {
    /* Remote revocation must still run if local storage fails. */
  }
  if (!options) return
  const url = new URL('/auth/revoke', options.websocketUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${options.sessionToken}` },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok && response.status !== 401)
    throw new Error(
      'Disconnected locally; remote revocation failed. Run revoke-web on the server.',
    )
}

export const invokeProcess = async (
  type: string,
  method: string,
  ...params: readonly unknown[]
): Promise<unknown> => {
  if (!state.options) await restore()
  const { options } = state
  if (!options)
    throw new RemoteServerError(
      'Remote server is not paired',
      'E_REMOTE_SERVER_NOT_PAIRED',
    )
  const { generation } = state
  let promise = state.rpcs.get(type)
  if (!promise) {
    promise = createRpc(options, state.generation, type)
    state.rpcs.set(type, promise)
    void promise.catch(() => {
      if (state.rpcs.get(type) === promise) state.rpcs.delete(type)
    })
  }
  const rpc = await promise
  if (state.options !== options || state.generation !== generation)
    throw new Error('Remote workspace changed')
  return rpc.invoke(method, ...params)
}

export const invoke = async (
  method: string,
  ...params: readonly unknown[]
): Promise<unknown> => invokeProcess('file-system-process', method, ...params)

export const getWebSocketUrl = async (
  type: string,
  params: Readonly<Record<string, string>> = {},
): Promise<string> => {
  if (!state.options) await restore()
  if (!state.options)
    throw new RemoteServerError(
      'Remote server is not paired',
      'E_REMOTE_SERVER_NOT_PAIRED',
    )
  return createWebSocketUrl(state.options, type, params)
}

export const trackConnection = (close: () => void): (() => void) => {
  connections.add(close)
  return () => connections.delete(close)
}

export const getOptions = (): ConnectionOptions | undefined => state.options

export const releaseWorkspace = async (uri: string): Promise<void> => {
  const { options } = state
  if (options && new URL(uri).host === new URL(options.websocketUrl).host) {
    set(options)
    await revokePreviews(options)
  }
}

export const getGeneration = (): number => state.generation

// A separate connection keeps bounded measurements from cancelling editor reads.
export const createBenchmarkRpc = async (signal: AbortSignal): Promise<Rpc> => {
  if (!state.options) await restore()
  const { generation, options } = state
  if (!options)
    throw new Error('Connect to a remote server before benchmarking')
  return createRpc(options, generation, 'file-system-process', signal)
}

export const validateAccountSession = async (): Promise<void> => {
  const { options } = state
  if (!options?.account) return
  const endpoint = new URL('/auth/session', options.websocketUrl)
  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:'
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${options.sessionToken}` },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 401 && state.options === options) await invalidate()
  else if (!response.ok)
    throw new Error(
      'Remote session unavailable. Check the server and retry connecting from your LVCE account.',
    )
}

export const openContainer = async (
  workspace: string,
): Promise<{ id: string; workspacePath: string }> => {
  if (!state.options) await restore()
  const { generation, options } = state
  if (!options)
    throw new Error(
      'Connect to a remote server before reopening in a container',
    )
  assertWorkspace(workspace)
  const endpoint = new URL('/devcontainer/open', options.websocketUrl)
  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:'
  endpoint.searchParams.set('workspace', ContainerWorkspace.getPath(workspace))
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${options.sessionToken}` },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.any([
      state.authorizationController.signal,
      AbortSignal.timeout(600_000),
    ]),
  })
  const result = await response.json()
  if (generation !== state.generation)
    throw new Error('Remote workspace changed while starting the container')
  if (!response.ok)
    throw new Error(
      result.error || 'Update the remote server to enable Dev Containers',
    )
  if (
    !/^[a-f0-9]{32}$/.test(result.id) ||
    typeof result.workspacePath !== 'string' ||
    !result.workspacePath.startsWith('/')
  )
    throw new Error('Invalid container workspace response')
  return result
}
