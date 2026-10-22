import * as Connection from './RemoteServerConnection.ts'

export const connect = async (
  workspaceUri: string,
  type: string,
  port: MessagePort,
  params: Readonly<Record<string, string>> = {},
): Promise<void> => {
  let dispose = (): void => port.close()
  try {
    Connection.assertWorkspace(workspaceUri)
    if (
      ![
        'terminal-process',
        'extension-node-process',
        'file-watcher-explorer',
      ].includes(type)
    )
      throw new Error('Unsupported remote workspace transport')
    const url = await Connection.getWebSocketUrl(type, params)
    Connection.assertWorkspace(workspaceUri)
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      let opened = false
      let disposed = false
      dispose = (): void => {
        if (disposed) return
        disposed = true
        clearTimeout(timeout)
        untrack()
        socket.onopen = null
        socket.onclose = null
        socket.onerror = null
        socket.onmessage = null
        port.onmessage = null
        port.removeEventListener('close', dispose)
        port.close()
        socket.close()
        if (!opened)
          reject(new Error('Remote workspace connection closed before opening'))
      }
      const timeout = setTimeout(dispose, 30_000)
      const untrack = Connection.trackConnection(dispose)
      port.addEventListener('close', dispose)
      port.onmessageerror = dispose
      socket.onerror = dispose
      socket.onclose = dispose
      socket.onmessage = (event): void => {
        try {
          const message = JSON.parse(String(event.data))
          if (message !== 'ready') port.postMessage(message)
        } catch {
          dispose()
        }
      }
      socket.onopen = (): void => {
        opened = true
        clearTimeout(timeout)
        port.onmessage = (event): void => {
          try {
            if (socket.bufferedAmount > 1024 * 1024)
              throw new Error('Remote workspace queue is full')
            socket.send(
              JSON.stringify(
                type === 'terminal-process'
                  ? getTerminalMessage(event.data, workspaceUri)
                  : event.data,
              ),
            )
          } catch {
            dispose()
          }
        }
        port.start()
        resolve()
      }
    })
  } catch (error) {
    dispose()
    throw error
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
  )
    return message
  if (!('params' in message) || !Array.isArray(message.params))
    throw new TypeError('Invalid terminal creation request')
  const [id, cwd, ...rest] = message.params
  if (typeof cwd === 'string' && cwd.startsWith('/') && !cwd.includes('\0'))
    return message
  const workspace = new URL(workspaceUri)
  const location = new URL(typeof cwd === 'string' && cwd ? cwd : workspaceUri)
  if (
    location.protocol !== workspace.protocol ||
    location.host !== workspace.host ||
    location.username ||
    location.password
  )
    throw new Error('Remote terminal directory belongs to a different server')
  return {
    ...message,
    params: [id, decodeURIComponent(location.pathname), ...rest],
  }
}

export const request = async (
  uri: string,
  type: string,
  args: readonly string[] = [],
): Promise<unknown> => {
  Connection.assertWorkspace(uri)
  const path = decodeURIComponent(new URL(uri).pathname)
  switch (type) {
    case 'file-search': {
      const result = await Connection.invokeProcess(
        'search-process',
        'SearchFile.searchFile',
        {
          limit: 100_000,
          ripGrepArgs: ['--files', '--hidden', '--glob', '!.git', '--'],
          searchPath: path,
        },
      )
      if (typeof result !== 'string')
        throw new TypeError('Invalid remote file search result')
      return result.split(/\r?\n/).filter(Boolean)
    }
    case 'git-remote':
      return Connection.invokeProcess(
        'shared-process',
        'Workspace.getGitRemote',
        path,
      )
    case 'terminal-options':
      return Connection.invokeProcess(
        'shared-process',
        'GetTerminalSpawnOptions.getTerminalSpawnOptions',
      )
    case 'text-search':
      return Connection.invokeProcess('search-process', 'TextSearch.search', {
        ripGrepArgs: args,
        searchDir: path,
      })
    default:
      throw new Error('Unsupported remote workspace request')
  }
}
