import { afterEach, expect, jest, test } from '@jest/globals'
import * as RemoteServerConnect from '../src/parts/RemoteServerConnect/RemoteServerConnect.ts'

const pairingResult = {
  authentication: 'websocket-ticket' as const,
  capabilities: [
    'file-system-process',
    'file-watcher-explorer',
    'terminal-process',
    'search-process',
    'shared-process',
    'extension-node-process',
  ],
  protocolVersion: 1 as const,
  sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  sessionToken: 'session-secret',
  websocketUrl: 'wss://remote.example.com/',
  workspacePath: '/home/test/project with spaces',
}

test('opens the paired remote workspace', async () => {
  const showInput = jest.fn<RemoteServerConnect.ShowQuickInput>(
    async () => 'https://remote.example.com/#token=pair',
  )
  const setUri = jest.fn<RemoteServerConnect.SetWorkspaceUri>(async () => {})
  const pairServer = jest.fn<(value: string) => Promise<typeof pairingResult>>(
    async () => pairingResult,
  )

  await RemoteServerConnect.connect(showInput, setUri, pairServer)

  expect(pairServer).toHaveBeenCalledWith(
    'https://remote.example.com/#token=pair',
  )
  expect(setUri).toHaveBeenCalledWith(
    'remote-server://remote.example.com/home/test/project%20with%20spaces',
    '/',
    {
      command: 'remote-server.getWebSocketUrl',
      disposeCommand: 'remote-server.releaseWorkspace',
      workspacePath: '/home/test/project with spaces',
    },
  )
})

test('opens a supplied pairing URL without prompting', async () => {
  const setUri = jest.fn<RemoteServerConnect.SetWorkspaceUri>(async () => {})
  const pairServer = jest.fn<(value: string) => Promise<typeof pairingResult>>(
    async () => pairingResult,
  )

  await RemoteServerConnect.connectWithPairingUrl(
    'https://remote.example.com/#token=pair',
    setUri,
    pairServer,
  )

  expect(pairServer).toHaveBeenCalledWith(
    'https://remote.example.com/#token=pair',
  )
  expect(setUri).toHaveBeenCalledWith(
    'remote-server://remote.example.com/home/test/project%20with%20spaces',
    '/',
    {
      command: 'remote-server.getWebSocketUrl',
      disposeCommand: 'remote-server.releaseWorkspace',
      workspacePath: '/home/test/project with spaces',
    },
  )
})

test('exchanges only the URL fragment pairing token', async () => {
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    json: async () => pairingResult,
    ok: true,
  } as Response)

  await expect(
    RemoteServerConnect.pair(
      'https://remote.example.com/public/path?ignored=true#token=pair-secret',
    ),
  ).resolves.toEqual(pairingResult)
  expect(fetchSpy).toHaveBeenCalledWith(
    new URL('https://remote.example.com/auth/pair'),
    {
      headers: { authorization: 'Bearer pair-secret', 'x-lvce-protocol': '1' },
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    },
  )
  fetchSpy.mockRestore()
})

test('allows an authenticated loopback server during local development', async () => {
  const localPairingResult = {
    ...pairingResult,
    websocketUrl: 'ws://127.0.0.1:3774/',
  }
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    json: async () => localPairingResult,
    ok: true,
  } as Response)

  await expect(
    RemoteServerConnect.pair('http://127.0.0.1:3774/#token=pair-secret'),
  ).resolves.toEqual(localPairingResult)
  fetchSpy.mockRestore()
})

test.each([
  new DOMException('request aborted #token=secret', 'AbortError'),
  new DOMException('request timed out #token=secret', 'TimeoutError'),
  new TypeError('network failed #token=secret'),
])(
  'reports actionable pairing network failures without native errors: %s',
  async (failure) => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(failure)
    try {
      let result: unknown
      try {
        await RemoteServerConnect.pair(
          'https://remote.example.com/#token=pair-secret',
        )
      } catch (error) {
        result = error
      }
      expect(result).toBeInstanceOf(Error)
      expect(Object.getPrototypeOf(result)).toBe(Error.prototype)
      expect(result).toMatchObject({
        message: expect.stringContaining('HTTPS certificate'),
      })
      expect((result as Error).message).toContain(
        'allow device or local network access',
      )
      expect((result as Error).message).not.toContain('secret')
      expect((result as Error).cause).toBeUndefined()
    } finally {
      fetchSpy.mockRestore()
    }
  },
)

test('rejects an insecure public pairing URL', async () => {
  await expect(
    // The intentionally insecure URL is the behavior under test.
    // eslint-disable-next-line unicorn/prefer-https
    RemoteServerConnect.pair('http://remote.example.com/#token=pair-secret'),
  ).rejects.toThrow(/HTTPS/)
})

test.each([
  { protocolVersion: 2 },
  { capabilities: ['file-system-process'] },
  {
    capabilities: pairingResult.capabilities.filter(
      (capability) => capability !== 'file-watcher-explorer',
    ),
  },
  { websocketUrl: 'wss://other.example.com/' },
  { websocketUrl: 'wss://user:secret@remote.example.com/' },
])(
  'rejects incompatible or redirected pairing responses: %j',
  async (override) => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ ...pairingResult, ...override }),
      ok: true,
    } as Response)
    try {
      await expect(
        RemoteServerConnect.pair('https://remote.example.com/#token=pair'),
      ).rejects.toThrow(
        'protocolVersion' in override || 'capabilities' in override
          ? 'Update the remote server and browser connector'
          : 'invalid pairing response',
      )
    } finally {
      fetchSpy.mockRestore()
    }
  },
)

test('restores the prior connection when workspace switching is cancelled', async () => {
  const connection =
    await import('../src/parts/RemoteServerConnection/RemoteServerConnection.ts')
  const previous = {
    sessionToken: 'previous',
    websocketUrl: 'wss://previous.example.com/',
  }
  connection.set(previous)
  const setUri = jest.fn<RemoteServerConnect.SetWorkspaceUri>(async () => {
    throw new Error('cancelled')
  })
  await expect(
    RemoteServerConnect.connectWithPairingUrl(
      'https://remote.example.com/#token=pair',
      setUri,
      async () => pairingResult,
    ),
  ).rejects.toThrow('cancelled')
  expect(connection.getOptions()).toBe(previous)
  await connection.dispose()
})

afterEach(async () => {
  const connection =
    await import('../src/parts/RemoteServerConnection/RemoteServerConnection.ts')
  await connection.dispose()
})

test('disconnect during pairing prevents the late response from opening a workspace', async () => {
  const connection =
    await import('../src/parts/RemoteServerConnection/RemoteServerConnection.ts')
  const { promise, resolve } = Promise.withResolvers<typeof pairingResult>()
  const setUri = jest.fn<RemoteServerConnect.SetWorkspaceUri>(async () => {})
  const pending = RemoteServerConnect.connectWithPairingUrl(
    'https://remote.example.com/#token=pair',
    setUri,
    () => promise,
  )
  void pending.catch(() => {})
  await connection.dispose()
  resolve(pairingResult)
  await expect(pending).rejects.toThrow('changed while pairing')
  expect(setUri).not.toHaveBeenCalled()
  expect(connection.getOptions()).toBeUndefined()
})

test('a cancelled old workspace switch cannot restore its session over a newer connection', async () => {
  const connection =
    await import('../src/parts/RemoteServerConnection/RemoteServerConnection.ts')
  const { promise, reject } = Promise.withResolvers<void>()
  const pending = RemoteServerConnect.connectWithPairingUrl(
    'https://remote.example.com/#token=pair',
    () => promise,
    async () => pairingResult,
  )
  void pending.catch(() => {})
  await Promise.resolve()
  const newer = { sessionToken: 'new', websocketUrl: 'wss://new.example.com/' }
  connection.set(newer)
  reject(new Error('cancelled'))
  await expect(pending).rejects.toThrow('cancelled')
  expect(connection.getOptions()).toBe(newer)
})

test('prepares a recently opened folder using the existing session without pairing again', async () => {
  const connection =
    await import('../src/parts/RemoteServerConnection/RemoteServerConnection.ts')
  connection.set({
    sessionToken: 'session-secret',
    websocketUrl: 'wss://remote.example.com/',
    workspaceUri: 'remote-server://remote.example.com/home/old',
  })
  await expect(
    RemoteServerConnect.prepareWorkspace(
      'remote-server://remote.example.com/home/test/other%20folder',
    ),
  ).resolves.toEqual({
    command: 'remote-server.getWebSocketUrl',
    disposeCommand: 'remote-server.releaseWorkspace',
    workspacePath: '/home/test/other folder',
  })
})
