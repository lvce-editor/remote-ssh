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

const toError = (value: RpcError | undefined): Error => {
  const error = new Error(
    value?.message || 'Remote workspace backend request failed',
  ) as NodeJS.ErrnoException
  const dataCode =
    value?.data && typeof value.data === 'object' && 'code' in value.data
      ? value.data.code
      : undefined
  const code = dataCode ?? value?.code
  if (typeof code === 'string' || typeof code === 'number') {
    error.code = String(code)
  }
  return error
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
    rejectReady(error)
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    pending.clear()
    onClose()
  }

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
      close(error instanceof Error ? error : new Error(String(error)))
      webSocket.close()
    }
  }

  webSocket.onopen = (): void => {
    resolveReady()
  }
  webSocket.onmessage = (event): void => {
    void handleMessage(event.data)
  }
  webSocket.onerror = (): void => {
    close(new Error('Remote workspace backend WebSocket failed'))
  }
  webSocket.onclose = (): void => {
    close(new Error('Remote workspace backend WebSocket closed'))
  }

  return {
    dispose(): void {
      close(new Error('Remote workspace backend connection disposed'))
      webSocket.close()
    },
    async invoke(
      method: string,
      ...params: readonly unknown[]
    ): Promise<unknown> {
      await ready
      if (closed) {
        throw new Error('Remote workspace backend connection is closed')
      }
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(
            new Error(
              'Remote workspace backend operation timed out after 120 seconds',
            ),
          )
        }, requestTimeout)
        pending.set(id, { reject, resolve, timeout })
        webSocket.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }))
      })
    },
  }
}
