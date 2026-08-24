interface WorkspaceBackend {
  readonly token: string
  readonly url: string
}

export const commandId = 'remote-ssh.getWebSocketUrl'

const state: { backend: WorkspaceBackend | undefined } = {
  backend: undefined,
}

const isLoopbackWebSocket = (url: URL): boolean => {
  return (
    url.protocol === 'ws:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
}

export const set = (backend: WorkspaceBackend): void => {
  const url = new URL(backend.url)
  if (!isLoopbackWebSocket(url) || !backend.token) {
    throw new TypeError(
      'Remote SSH workspace connection must use an authenticated loopback WebSocket',
    )
  }
  state.backend = backend
}

export const reset = (): void => {
  state.backend = undefined
}

export const getWebSocketUrl = (type: string): string => {
  if (!state.backend) {
    throw new Error('Remote SSH workspace connection is not available')
  }
  const url = new URL(
    `/websocket/${encodeURIComponent(type)}`,
    state.backend.url,
  )
  url.searchParams.set('token', state.backend.token)
  return url.href
}
