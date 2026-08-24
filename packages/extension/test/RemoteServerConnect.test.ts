import { expect, jest, test } from '@jest/globals'
import * as RemoteServerConnect from '../src/parts/RemoteServerConnect/RemoteServerConnect.ts'

const pairingResult = {
  authentication: 'websocket-ticket' as const,
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
      authentication: 'websocket-ticket',
      token: 'session-secret',
      url: 'wss://remote.example.com/',
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
      headers: { authorization: 'Bearer pair-secret' },
      method: 'POST',
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
