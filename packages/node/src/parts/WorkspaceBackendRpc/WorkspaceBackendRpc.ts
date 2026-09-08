import { RemoteSshError } from '../RemoteSshError/RemoteSshError.ts'

interface RpcError {
  readonly code?: number | string
  readonly data?: unknown
  readonly message?: string
}

interface RpcResponse {
  readonly error?: RpcError
  readonly id?: number | string | null
  readonly result?: unknown
}

interface PendingRequest {
  readonly reject: (error: Error) => void
  readonly resolve: (value: unknown) => void
  readonly timeout: NodeJS.Timeout
}

export interface WorkspaceBackendRpc {
  readonly dispose: () => void
  readonly invoke: (
    method: string,
    ...params: readonly unknown[]
  ) => Promise<unknown>
}

type WebSocketLike = Pick<
  WebSocket,
  'close' | 'onclose' | 'onerror' | 'onmessage' | 'onopen' | 'send'
>

const requestTimeout = 120_000

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

const toError = (value: RpcError | undefined): Error => {
  const dataCode =
    value?.data && typeof value.data === 'object' && 'code' in value.data
      ? value.data.code
      : undefined
  const code = dataCode ?? value?.code
  return new RemoteSshError(
    value?.message || 'Remote workspace backend request failed',
    typeof code === 'string' || typeof code === 'number'
      ? String(code)
      : 'E_REMOTE_BACKEND_REQUEST_FAILED',
  )
}

const getMessageText = async (data: unknown): Promise<string> => {
  if (typeof data === 'string') {
    return data
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8')
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      'utf8',
    )
  }
  if (data instanceof Blob) {
    return data.text()
  }
  throw new TypeError(
    'Remote workspace backend returned unsupported message data',
  )
}

export const create = (
  url: string,
  createWebSocket: (url: string) => WebSocketLike = (value) =>
    new WebSocket(value),
  onClose: () => void = () => {},
): WorkspaceBackendRpc => {
  const webSocket = createWebSocket(url)
  let closed = false
  let nextId = 1
  const pending = new Map<number, PendingRequest>()
  const {
    promise: ready,
    reject: rejectReady,
    resolve: resolveReady,
  } = Promise.withResolvers<void>()

  const close = (error: Error): void => {
    if (closed) {
      return
    }
    closed = true
    clearTimeout(readyTimeout)
    rejectReady(error)
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    pending.clear()
    onClose()
  }

  const readyTimeout = setTimeout(() => {
    close(
      new RemoteSshError(
        'Remote workspace backend WebSocket handshake timed out after 10 seconds',
        'E_REMOTE_BACKEND_CONNECTION_TIMEOUT',
      ),
    )
    webSocket.close()
  }, 10_000)

  const handleMessage = async (data: unknown): Promise<void> => {
    try {
      const response = JSON.parse(await getMessageText(data)) as RpcResponse
      if (
        !response ||
        typeof response !== 'object' ||
        typeof response.id !== 'number'
      ) {
        throw new TypeError(
          'Remote workspace backend returned an invalid JSON-RPC response',
        )
      }
      const request = pending.get(response.id)
      if (!request) {
        return
      }
      clearTimeout(request.timeout)
      pending.delete(response.id)
      if (response.error) {
        request.reject(toError(response.error))
      } else {
        request.resolve(response.result)
      }
    } catch (error) {
      close(
        new RemoteSshError(
          error instanceof Error ? error.message : String(error),
          'E_REMOTE_BACKEND_INVALID_RESPONSE',
          error,
        ),
      )
      webSocket.close()
    }
  }

  webSocket.onopen = (): void => {
    clearTimeout(readyTimeout)
    resolveReady()
  }
  webSocket.onmessage = (event): void => {
    void handleMessage(event.data)
  }
  webSocket.onerror = (event): void => {
    const detail = getWebSocketErrorDetail(event)
    const suffix = detail ? `: ${detail}` : ''
    close(
      new RemoteSshError(
        `Remote workspace backend WebSocket failed${suffix}`,
        'E_REMOTE_BACKEND_WEBSOCKET_ERROR',
      ),
    )
  }
  webSocket.onclose = (event): void => {
    close(
      new RemoteSshError(
        `Remote workspace backend WebSocket closed${getWebSocketCloseDetail(event)}`,
        'E_REMOTE_BACKEND_WEBSOCKET_CLOSED',
      ),
    )
  }

  return {
    dispose(): void {
      close(
        new RemoteSshError(
          'Remote workspace backend connection disposed',
          'E_REMOTE_BACKEND_CONNECTION_DISPOSED',
        ),
      )
      webSocket.close()
    },
    async invoke(
      method: string,
      ...params: readonly unknown[]
    ): Promise<unknown> {
      await ready
      if (closed) {
        throw new RemoteSshError(
          'Remote workspace backend connection is closed',
          'E_REMOTE_BACKEND_CONNECTION_CLOSED',
        )
      }
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(
            new RemoteSshError(
              'Remote workspace backend operation timed out after 120 seconds',
              'E_REMOTE_BACKEND_REQUEST_TIMEOUT',
            ),
          )
        }, requestTimeout)
        pending.set(id, { reject, resolve, timeout })
        webSocket.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }))
      })
    },
  }
}
