interface ConnectionOptions {
  readonly sessionToken: string
  readonly websocketUrl: string
}

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
  generation: number
  options: ConnectionOptions | undefined
  rpc: Promise<Rpc> | undefined
} = {
  generation: 0,
  options: undefined,
  rpc: undefined,
}

const toError = (value: RpcError | undefined): Error => {
  const error = new Error(
    value?.message || 'Remote server request failed',
  ) as Error & { code?: string }
  const code = value?.data?.code ?? value?.code
  if (typeof code === 'string' || typeof code === 'number') {
    error.code = String(code)
  }
  return error
}

const getTicket = async (options: ConnectionOptions): Promise<string> => {
  const endpoint = new URL('/auth/websocket-ticket', options.websocketUrl)
  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:'
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${options.sessionToken}` },
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(
      `Failed to authorize remote file system (${response.status})`,
    )
  }
  const result = (await response.json()) as { readonly ticket?: unknown }
  if (typeof result.ticket !== 'string') {
    throw new TypeError('Remote server returned an invalid WebSocket ticket')
  }
  return result.ticket
}

const createRpc = async (
  options: ConnectionOptions,
  generation: number,
): Promise<Rpc> => {
  const url = new URL('/websocket/file-system-process', options.websocketUrl)
  url.searchParams.set('ticket', await getTicket(options))
  const webSocket = new WebSocket(url)
  const pending = new Map<number, PendingRequest>()
  let nextId = 1
  let closed = false
  const { promise: ready, reject, resolve } = Promise.withResolvers<void>()

  const close = (
    error = new Error('Remote server connection closed'),
  ): void => {
    if (closed) {
      return
    }
    closed = true
    reject(error)
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    pending.clear()
    if (state.generation === generation) {
      state.rpc = undefined
    }
  }

  webSocket.onopen = (): void => resolve()
  webSocket.onerror = (): void =>
    close(new Error('Remote server WebSocket failed'))
  webSocket.onclose = (): void => close()
  webSocket.onmessage = (event): void => {
    try {
      const response = JSON.parse(String(event.data)) as RpcResponse
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
      close(error instanceof Error ? error : new Error(String(error)))
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
        throw new Error('Remote server connection is closed')
      }
      const id = nextId++
      return new Promise((resolveRequest, rejectRequest) => {
        const timeout = setTimeout(() => {
          pending.delete(id)
          rejectRequest(new Error('Remote server request timed out'))
        }, 120_000)
        pending.set(id, {
          reject: rejectRequest,
          resolve: resolveRequest,
          timeout,
        })
        webSocket.send(JSON.stringify({ id, jsonrpc: '2.0', method, params }))
      })
    },
  }
}

const closeRpc = async (rpcPromise: Promise<Rpc>): Promise<void> => {
  try {
    const rpc = await rpcPromise
    rpc.close()
  } catch {
    // A failed connection has no live transport to close.
  }
}

export const set = (options: ConnectionOptions): void => {
  if (state.rpc) {
    void closeRpc(state.rpc)
  }
  state.generation++
  state.options = options
  state.rpc = undefined
}

export const dispose = async (): Promise<void> => {
  const { rpc } = state
  state.generation++
  state.options = undefined
  state.rpc = undefined
  if (rpc) {
    await closeRpc(rpc)
  }
}

export const invoke = async (
  method: string,
  ...params: readonly unknown[]
): Promise<unknown> => {
  if (!state.options) {
    throw new Error('Remote server is not paired')
  }
  state.rpc ||= createRpc(state.options, state.generation)
  const rpc = await state.rpc
  return rpc.invoke(method, ...params)
}
