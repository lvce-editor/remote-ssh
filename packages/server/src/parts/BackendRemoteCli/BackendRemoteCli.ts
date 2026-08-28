import WebSocket from 'ws'
import type { OpenRequest } from '../RemoteCli/RemoteCli.ts'

interface Backend {
  readonly port: number
  readonly token: string
}

interface RpcResponse {
  readonly error?: { readonly message?: string }
  readonly id?: number
  readonly result?: unknown
}

interface WebSocketLike {
  readonly close: () => void
  onclose: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onopen: (() => void) | null
  readonly send: (value: string) => void
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
  throw new TypeError('Remote workspace backend returned invalid data')
}

export const open = (
  backend: Backend,
  request: OpenRequest,
  createWebSocket: (url: string) => WebSocketLike = (url) =>
    new WebSocket(url) as unknown as WebSocketLike,
): Promise<boolean> => {
  const url = new URL(
    `/websocket/shared-process`,
    `ws://127.0.0.1:${backend.port}`,
  )
  url.searchParams.set('token', backend.token)
  const webSocket = createWebSocket(url.href)
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      finish(new Error('Remote CLI workspace request timed out'))
    }, 10_000)
    timeout.unref()
    const finish = (error?: Error, result?: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      webSocket.close()
      if (error) {
        reject(error)
      } else {
        resolve(result === true)
      }
    }
    webSocket.onopen = (): void => {
      webSocket.send(
        JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'RemoteCli.open',
          params: [request],
        }),
      )
    }
    webSocket.onmessage = (event): void => {
      void getMessageText(event.data)
        .then((text) => {
          const response = JSON.parse(text) as RpcResponse
          if (response.id !== 1) {
            throw new TypeError(
              'Remote workspace backend returned an invalid response',
            )
          }
          if (response.error) {
            throw new Error(
              response.error.message || 'Remote CLI workspace request failed',
            )
          }
          finish(undefined, response.result === true)
        })
        .catch((error) =>
          finish(error instanceof Error ? error : new Error(String(error))),
        )
    }
    webSocket.onerror = (): void => {
      finish(new Error('Remote CLI workspace connection failed'))
    }
    webSocket.onclose = (): void => {
      finish(new Error('Remote CLI workspace connection closed'))
    }
  })
}
