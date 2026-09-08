import * as Rpc from '../Rpc/Rpc.ts'
import * as WorkspaceConnection from '../WorkspaceConnection/WorkspaceConnection.ts'

const state = { generation: 0 }

const connections = new Set<() => void>()
const connectionTimeout = 30_000

export const bridge = (
  port: MessagePort,
  socket: WebSocket,
  mapMessage: (message: unknown) => unknown = (message) => message,
): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    let opened = false
    let disposed = false
    const close = (): void => {
      if (disposed) {
        return
      }
      disposed = true
      clearTimeout(timeout)
      connections.delete(close)
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      port.onmessage = null
      port.onmessageerror = null
      port.removeEventListener('close', close)
      port.close()
      socket.close()
      if (!opened) {
        reject(new Error('Remote SSH process connection closed before opening'))
      }
    }
    const timeout = setTimeout(close, connectionTimeout)
    connections.add(close)
    port.addEventListener('close', close)
    port.onmessageerror = close
    socket.onerror = close
    socket.onclose = close
    socket.onmessage = (event): void => {
      try {
        port.postMessage(JSON.parse(event.data))
      } catch {
        close()
      }
    }
    socket.onopen = (): void => {
      opened = true
      clearTimeout(timeout)
      port.onmessage = (event): void => {
        try {
          socket.send(JSON.stringify(mapMessage(event.data)))
        } catch {
          close()
        }
      }
      port.start()
      resolve()
    }
  })
}

export const connect = async (
  workspaceUri: string,
  type: string,
  port: MessagePort,
  params: Readonly<Record<string, string>> = {},
): Promise<void> => {
  const currentGeneration = state.generation
  try {
    if (!workspaceUri.startsWith('remote-ssh://')) {
      throw new Error('Remote SSH transport requires an SSH workspace')
    }
    if (type !== 'terminal-process' && type !== 'extension-node-process') {
      throw new Error(`Unsupported remote SSH process: ${type}`)
    }
    if (
      type === 'extension-node-process' &&
      (!params.extensionId || !params.rpcId)
    ) {
      throw new Error(
        'Remote extension process requires an extension and RPC id',
      )
    }
    const backend = (await Rpc.invoke(
      'SshFileSystem.connect',
      workspaceUri,
    )) as WorkspaceConnection.WorkspaceBackend
    if (currentGeneration !== state.generation) {
      throw new Error('Remote SSH transport was disposed while connecting')
    }
    // Validate the authenticated tunnel before using it in the extension's CSP.
    WorkspaceConnection.set(backend)
    const url = new URL(
      WorkspaceConnection.getWebSocketUrlForBackend(backend, type),
    )
    if (type === 'extension-node-process') {
      url.searchParams.set('extensionId', params.extensionId)
      url.searchParams.set('rpcId', params.rpcId)
    }
    await bridge(
      port,
      new WebSocket(url),
      type === 'terminal-process'
        ? (message): unknown => getTerminalMessage(message, workspaceUri)
        : undefined,
    )
  } catch (error) {
    port.close()
    throw error
  }
}

export const dispose = (): void => {
  state.generation++
  for (const close of connections) {
    close()
  }
}

export const getTerminalMessage = (
  message: unknown,
  workspaceUri: string,
): unknown => {
  if (
    !message ||
    typeof message !== 'object' ||
    !('method' in message) ||
    message.method !== 'Terminal.create'
  ) {
    return message
  }
  if (!('params' in message) || !Array.isArray(message.params)) {
    throw new TypeError('Invalid terminal creation request')
  }
  const [id, cwd, ...rest] = message.params
  const workspace = new URL(workspaceUri)
  const location = new URL(typeof cwd === 'string' && cwd ? cwd : workspaceUri)
  if (
    location.protocol !== workspace.protocol ||
    location.host !== workspace.host ||
    location.username !== workspace.username
  ) {
    throw new Error(
      'Remote terminal directory belongs to a different workspace host',
    )
  }
  return {
    ...message,
    params: [id, decodeURIComponent(location.pathname), ...rest],
  }
}
