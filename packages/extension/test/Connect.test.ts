import type { NotificationType } from '@lvce-editor/api'
import { expect, jest, test } from '@jest/globals'
import {
  connect,
  placeholder,
  restore,
  setRemoteWorkspaceUri,
} from '../src/parts/Connect/Connect.ts'

const backend = {
  token: 'secret',
  url: 'ws://127.0.0.1:45123',
  workspacePath: '/work',
}

test('uses an extension-owned connection command with a current LVCE host', async () => {
  const execute = jest
    .fn<(id: string, ...args: readonly unknown[]) => Promise<unknown>>()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(undefined)

  await setRemoteWorkspaceUri(
    'remote-ssh://user@example.com/work',
    backend,
    execute,
  )

  expect(execute).toHaveBeenNthCalledWith(
    1,
    'Workspace.supportsConnectionCommand',
  )
  expect(execute).toHaveBeenNthCalledWith(
    2,
    'Workspace.setUri',
    'remote-ssh://user@example.com/work',
    '/',
    {
      command: 'remote-ssh.getWebSocketUrl',
      remoteCliUrl:
        'ws://127.0.0.1:45123/websocket/shared-process?token=secret',
      webSocketUrl:
        'ws://127.0.0.1:45123/websocket/file-system-process?token=secret',
      workspacePath: '/work',
    },
  )
})

test('uses the legacy backend object with an older LVCE host', async () => {
  const execute = jest
    .fn<(id: string, ...args: readonly unknown[]) => Promise<unknown>>()
    .mockRejectedValueOnce(new Error('command not found'))
    .mockResolvedValueOnce(undefined)

  await setRemoteWorkspaceUri(
    'remote-ssh://user@example.com/work',
    backend,
    execute,
  )

  expect(execute).toHaveBeenNthCalledWith(
    2,
    'Workspace.setUri',
    'remote-ssh://user@example.com/work',
    '/',
    backend,
  )
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
