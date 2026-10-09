import type { NotificationType } from '@lvce-editor/api'
import { beforeEach, expect, jest, test } from '@jest/globals'
import {
  connect as connectWithLogging,
  placeholder,
  restore as restoreWithLogging,
  setRemoteWorkspaceUri,
} from '../src/parts/Connect/Connect.ts'

const log = jest.fn(async (_message: string) => {})

const connect = (
  ...args: Parameters<typeof connectWithLogging>
): Promise<void> => {
  args[10] = log
  return connectWithLogging(...args)
}

const restore = (
  ...args: Parameters<typeof restoreWithLogging>
): Promise<void> => {
  args[7] = log
  return restoreWithLogging(...args)
}

beforeEach(() => {
  log.mockClear()
})

const backend = {
  token: 'secret',
  url: 'ws://127.0.0.1:45123',
  workspacePath: '/work',
}

test('keeps remote URIs and transport credentials inside the extension', async () => {
  const execute = jest.fn<
    (id: string, ...args: readonly unknown[]) => Promise<unknown>
  >(async () => {})
  await setRemoteWorkspaceUri(
    'remote-ssh://user@example.com/work',
    backend,
    execute,
  )
  expect(execute.mock.calls).toEqual([
    ['Workspace.setUri', 'remote-ssh://user@example.com/work'],
  ])
})

test('cancellation leaves the workspace unchanged', async () => {
  const showInput = jest.fn(
    async (_options?: { readonly placeholder?: string }) => undefined,
  )
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async (_uri: string) => {})
  const getHosts = jest.fn(async () => [] as readonly string[])

  await connect(showInput, setUri, connectRemote, undefined, getHosts)

  expect(showInput).toHaveBeenCalledWith({ placeholder })
  expect(connectRemote).not.toHaveBeenCalled()
  expect(setUri).not.toHaveBeenCalled()
})

test.each(['', ' '.repeat(3), '\n\t'])(
  'blank input %p leaves the workspace unchanged',
  async (value) => {
    const showInput = jest.fn(async () => value)
    const setUri = jest.fn(async (_uri: string) => {})
    const connectRemote = jest.fn(async (_uri: string) => {})
    const getHosts = jest.fn(async () => [] as readonly string[])

    await connect(showInput, setUri, connectRemote, undefined, getHosts)

    expect(connectRemote).not.toHaveBeenCalled()
    expect(setUri).not.toHaveBeenCalled()
  },
)

test('connects and switches to the remote backend', async () => {
  const showInput = jest.fn(async () => '  user@example.com  ')
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async (_uri: string) => backend)
  const getHosts = jest.fn(async () => [] as readonly string[])
  const watchRemoteCli = jest.fn((_uri: string) => {})

  await connect(
    showInput,
    setUri,
    connectRemote,
    (callback) => callback(),
    getHosts,
    undefined,
    watchRemoteCli,
  )

  expect(connectRemote).toHaveBeenCalledWith('remote-ssh://user@example.com/')
  expect(setUri.mock.calls).toContainEqual([
    'remote-ssh://user@example.com/',
    backend,
  ])
  expect(watchRemoteCli).toHaveBeenCalledWith('remote-ssh://user@example.com/')
})

test('restores a directly opened remote workspace backend', async () => {
  const rootBackend = { ...backend, workspacePath: '/' }
  const setUri = jest.fn(
    async (_uri: string, _workspaceBackend: typeof backend) => {},
  )
  const connectRemote = jest.fn(async (_uri: string) => rootBackend)
  const watchRemoteCli = jest.fn((_uri: string) => {})

  await restore(
    'remote-ssh://user@example.com/',
    setUri,
    connectRemote,
    watchRemoteCli,
  )

  expect(connectRemote).toHaveBeenCalledWith('remote-ssh://user@example.com/')
  expect(setUri).toHaveBeenCalledWith(
    'remote-ssh://user@example.com/',
    rootBackend,
  )
  expect(watchRemoteCli).toHaveBeenCalledWith('remote-ssh://user@example.com/')
})

test('reports connection and workspace opening stages during restore', async () => {
  const startProgress = jest.fn(async (_message: string) => 7)
  const updateProgress = jest.fn(async (_id: number, _message: string) => {})
  const rootBackend = { ...backend, workspacePath: '/' }

  await restoreWithLogging(
    'remote-ssh://user@example.com/',
    async () => {},
    async () => rootBackend,
    () => {},
    undefined,
    startProgress,
    async () => {},
    log,
    updateProgress,
    async () => {},
    async () => false,
  )

  expect(startProgress).toHaveBeenCalledWith(
    'Establishing connection to the Remote SSH host…',
  )
  expect(updateProgress).toHaveBeenCalledWith(
    7,
    'Opening Remote SSH workspace…',
  )
})

test('closing workspace progress cancels setup without reporting a connection error', async () => {
  const startProgress = jest.fn(async (_message: string) => 42)
  const cancelRemote = jest.fn(async (_uri: string, _id: number) => {})
  const updateProgress = jest.fn(async (_id: number, _message: string) => {})
  const showNotification = jest.fn(
    async (_type: NotificationType, _message: string) => {},
  )
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(
    async (_uri: string, _id?: number) => new Promise(() => {}),
  )

  await restoreWithLogging(
    'remote-ssh://user@example.com/',
    setUri,
    connectRemote,
    () => {},
    showNotification,
    startProgress,
    async () => {},
    log,
    updateProgress,
    cancelRemote,
    async (id) => id === 42,
  )

  expect(cancelRemote).toHaveBeenCalledWith(
    'remote-ssh://user@example.com/',
    42,
  )
  expect(setUri).not.toHaveBeenCalled()
  expect(showNotification).not.toHaveBeenCalled()
})

test('starts watching remote CLI requests before restoring the workspace', async () => {
  const rootBackend = { ...backend, workspacePath: '/' }
  const watchRemoteCli = jest.fn((_uri: string) => {})
  let watcherWasActive = false
  const setUri = jest.fn(async () => {
    watcherWasActive = watchRemoteCli.mock.calls.length > 0
  })
  const connectRemote = jest.fn(async () => rootBackend)

  await restore(
    'remote-ssh://user@example.com/',
    setUri,
    connectRemote,
    watchRemoteCli,
  )

  expect(watcherWasActive).toBe(true)
})

test('starts watching remote CLI requests before switching workspaces', async () => {
  const showInput = jest.fn(async () => 'user@example.com')
  const watchRemoteCli = jest.fn((_uri: string) => {})
  let watcherWasActive = false
  const setUri = jest.fn(async () => {
    watcherWasActive = watchRemoteCli.mock.calls.length > 0
  })
  const connectRemote = jest.fn(async () => backend)
  const getHosts = jest.fn(async () => [] as readonly string[])

  await connect(
    showInput,
    setUri,
    connectRemote,
    (callback) => callback(),
    getHosts,
    undefined,
    watchRemoteCli,
  )
  await Promise.resolve()

  expect(watcherWasActive).toBe(true)
})

test('reports SSH connection failures without switching workspaces', async () => {
  const showInput = jest.fn(async () => 'missing.example.com')
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async () => {
    throw new Error('connection failed')
  })
  const getHosts = jest.fn(async () => [] as readonly string[])
  const showNotification = jest.fn(
    async (_type: NotificationType, _message: string) => {},
  )

  await expect(
    connect(
      showInput,
      setUri,
      connectRemote,
      undefined,
      getHosts,
      undefined,
      undefined,
      showNotification,
    ),
  ).rejects.toThrow('connection failed')
  expect(showNotification).toHaveBeenCalledWith(
    'error',
    'Failed to connect to SSH target: connection failed',
  )
  expect(setUri).not.toHaveBeenCalled()
  expect(log).toHaveBeenLastCalledWith(
    'ERROR: Failed to connect to SSH target: connection failed',
  )
})

test('reports invalid SSH targets without starting a connection', async () => {
  const showInput = jest.fn(async () => 'ssh -i key example.com')
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async (_uri: string) => backend)
  const getHosts = jest.fn(async () => [] as readonly string[])
  const showNotification = jest.fn(
    async (_type: NotificationType, _message: string) => {},
  )

  await expect(
    connect(
      showInput,
      setUri,
      connectRemote,
      undefined,
      getHosts,
      undefined,
      undefined,
      showNotification,
    ),
  ).rejects.toThrow('Unsupported SSH option or argument: -i')
  expect(showNotification).toHaveBeenCalledWith(
    'error',
    'Failed to connect to SSH target: Unsupported SSH option or argument: -i',
  )
  expect(connectRemote).not.toHaveBeenCalled()
  expect(setUri).not.toHaveBeenCalled()
})

test('shows SSH config hosts and accepts a selected host', async () => {
  const showInput = jest.fn(async () => undefined)
  const showPick = jest.fn(async (_options: unknown) => 'staging')
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async (_uri: string) => backend)
  const getHosts = jest.fn(async () => ['work', 'staging'])

  await connect(
    showInput,
    setUri,
    connectRemote,
    (callback) => callback(),
    getHosts,
    showPick,
  )

  expect(showInput).not.toHaveBeenCalled()
  expect(showPick).toHaveBeenCalledWith({
    acceptInput: true,
    items: [
      { description: 'SSH config', label: 'work', value: 'work' },
      { description: 'SSH config', label: 'staging', value: 'staging' },
    ],
    placeholder,
  })
  expect(connectRemote).toHaveBeenCalledWith('remote-ssh://staging/')
  expect(setUri.mock.calls).toContainEqual(['remote-ssh://staging/', backend])
})

test('accepts a free-form target while showing SSH config hosts', async () => {
  const showInput = jest.fn(async () => undefined)
  const showPick = jest.fn(async (_options: unknown) => 'user@example.com')
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async (_uri: string) => backend)
  const getHosts = jest.fn(async () => ['work'])

  await connect(
    showInput,
    setUri,
    connectRemote,
    (callback) => callback(),
    getHosts,
    showPick,
  )

  expect(connectRemote).toHaveBeenCalledWith('remote-ssh://user@example.com/')
})

test('canceling configured host selection leaves workspace unchanged', async () => {
  const showInput = jest.fn(async () => undefined)
  const showPick = jest.fn(async (_options: unknown) => undefined)
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async (_uri: string) => {})
  const getHosts = jest.fn(async () => ['work'])

  await connect(showInput, setUri, connectRemote, undefined, getHosts, showPick)

  expect(connectRemote).not.toHaveBeenCalled()
  expect(setUri).not.toHaveBeenCalled()
})

test('falls back to free-form input when configured hosts cannot be read', async () => {
  const showInput = jest.fn(async (_options: unknown) => 'user@example.com')
  const showPick = jest.fn(async (_options: unknown) => undefined)
  const setUri = jest.fn(async (_uri: string) => {})
  const connectRemote = jest.fn(async (_uri: string) => backend)
  const getHosts = jest.fn(async (): Promise<readonly string[]> => {
    throw new Error('RPC unavailable')
  })

  await connect(
    showInput,
    setUri,
    connectRemote,
    (callback) => callback(),
    getHosts,
    showPick,
  )

  expect(showInput).toHaveBeenCalledWith({ placeholder })
  expect(showPick).not.toHaveBeenCalled()
  expect(connectRemote).toHaveBeenCalledWith('remote-ssh://user@example.com/')
})

test('reports a failed restore with its diagnostic code', async () => {
  const error = Object.assign(
    new Error('SSH connected, but the server failed to start'),
    { code: 'E_SSH_SERVER_START_FAILED' },
  )
  const notify = jest.fn(
    async (_type: NotificationType, _message: string) => {},
  )
  await expect(
    restore(
      'remote-ssh://host/',
      async () => {},
      async () => {
        throw error
      },
      () => {},
      notify,
    ),
  ).rejects.toBe(error)
  expect(notify).toHaveBeenCalledWith(
    'error',
    'Failed to connect to SSH target: SSH connected, but the server failed to start (E_SSH_SERVER_START_FAILED)',
  )
})

test('reports failure while switching to an already connected workspace', async () => {
  const notify = jest.fn(
    async (_type: NotificationType, _message: string) => {},
  )
  const error = new Error('Remote backend disconnected')
  await connect(
    async () => 'host',
    async () => {
      throw error
    },
    async () => backend,
    (callback) => callback(),
    async () => [],
    undefined,
    () => {},
    notify,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(notify).toHaveBeenCalledWith(
    'error',
    'Failed to connect to SSH target: Remote backend disconnected',
  )
  expect(log).toHaveBeenLastCalledWith(
    'ERROR: Failed to connect to SSH target: Remote backend disconnected',
  )
  expect(
    log.mock.calls.some(([line]) =>
      line.startsWith('Connected to SSH workspace'),
    ),
  ).toBe(false)
})

test('logs elapsed time only after the workspace is open', async () => {
  const now = jest.spyOn(performance, 'now')
  now.mockReturnValue(100)
  const { promise, resolve } = Promise.withResolvers<void>()
  const setUri = jest.fn(() => promise)
  const finished = restore(
    'remote-ssh://host/',
    setUri,
    async () => backend,
    () => {},
  )
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setUri).toHaveBeenCalled()
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'Restoring SSH connection to remote-ssh://host/',
      'Opening SSH workspace remote-ssh://host/',
    ])
    now.mockReturnValue(1734)
    resolve()
    await finished
    expect(log).toHaveBeenLastCalledWith(
      'Connected to SSH workspace remote-ssh://host/ in 1634 ms',
    )
  } finally {
    resolve()
    now.mockRestore()
  }
})

test('keeps workspace progress active through the connection and workspace switch', async () => {
  const startProgress = jest.fn(async (_message: string) => 42)
  const endProgress = jest.fn(async (_id: number) => {})
  const connectRemote = jest.fn(async (_uri: string) => backend)
  const setUri = jest.fn(async (_uri: string) => {})
  const updateProgress = jest.fn(async (_id: number, _message: string) => {})

  await connect(
    async () => 'user@example.com',
    setUri,
    connectRemote,
    (callback) => callback(),
    async () => [],
    undefined,
    undefined,
    undefined,
    startProgress,
    endProgress,
    log,
    updateProgress,
    async () => {},
    async () => false,
  )

  expect(startProgress).toHaveBeenCalledWith(
    'Establishing connection to the Remote SSH host…',
  )
  expect(connectRemote).toHaveBeenCalled()
  expect(updateProgress).toHaveBeenCalledWith(
    42,
    'Opening Remote SSH workspace…',
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(setUri).toHaveBeenCalled()
  expect(endProgress).toHaveBeenCalledWith(42)
})

test('clears workspace progress when connection fails', async () => {
  const startProgress = jest.fn(async (_message: string) => 42)
  const endProgress = jest.fn(async (_id: number) => {})
  const error = new Error('connection failed')

  await expect(
    connect(
      async () => 'user@example.com',
      async () => {},
      async () => {
        throw error
      },
      undefined,
      async () => [],
      undefined,
      undefined,
      async () => {},
      startProgress,
      endProgress,
    ),
  ).rejects.toBe(error)

  expect(endProgress).toHaveBeenCalledWith(42)
})
