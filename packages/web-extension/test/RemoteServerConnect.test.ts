import { afterEach, expect, jest, test } from '@jest/globals'
import * as RemoteServerConnect from '../src/parts/RemoteServerConnect/RemoteServerConnect.ts'

const pairingResult = {
  authentication: 'websocket-ticket' as const,
  capabilities: [
    'file-system-process',
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
