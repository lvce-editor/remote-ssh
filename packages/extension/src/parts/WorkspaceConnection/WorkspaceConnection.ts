export interface WorkspaceBackend {
  readonly token: string
  readonly url: string
}

interface BackendWaiter {
  readonly reject: (error: Error) => void
  readonly resolve: (backend: WorkspaceBackend) => void
}

export const commandId = 'remote-ssh.getWebSocketUrl'

const state: { backend: WorkspaceBackend | undefined } = {
  backend: undefined,
}

const backendWaiters = new Set<BackendWaiter>()

const createUnavailableError = (): Error => {
  return new Error('Remote SSH workspace connection is not available')
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
  for (const waiter of backendWaiters) {
    waiter.resolve(backend)
  }
  backendWaiters.clear()
}

export const reset = (): void => {
  state.backend = undefined
  const error = createUnavailableError()
  for (const waiter of backendWaiters) {
    waiter.reject(error)
  }
  backendWaiters.clear()
}

const getBackend = async (): Promise<WorkspaceBackend> => {
  if (state.backend) {
    return state.backend
  }
  return new Promise<WorkspaceBackend>((resolve, reject) => {
    backendWaiters.add({ reject, resolve })
  })
}

export const getWebSocketUrl = async (type: string): Promise<string> => {
  console.error(`[DEBUG-remote-cli] getWebSocketUrl start ${type}`)
  const backend = await getBackend()
  const url = getWebSocketUrlForBackend(backend, type)
  console.error(`[DEBUG-remote-cli] getWebSocketUrl complete ${type}`)
  return url
}

export const getWebSocketUrlForBackend = (
  backend: WorkspaceBackend,
  type: string,
): string => {
  const url = new URL(`/websocket/${encodeURIComponent(type)}`, backend.url)
  url.searchParams.set('token', backend.token)
  return url.href
}
