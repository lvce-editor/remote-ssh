import { afterEach, expect, jest, test } from '@jest/globals'
import * as Connection from '../src/parts/RemoteServerConnection/RemoteServerConnection.ts'
import * as Session from '../src/parts/RemoteServerSession/RemoteServerSession.ts'

const options = (): Connection.ConnectionOptions & {
  expiresAt: number
  workspaceUri: string
} => ({
  expiresAt: Date.now() + 60_000,
  sessionToken: 'a'.repeat(64),
  websocketUrl: 'wss://remote.example/',
  workspaceUri: 'remote-server://remote.example/home/test/project',
})
const configure = (): Map<string, string> => {
  const values = new Map<string, string>()
  Session.configure({
    deleteSecret: async (key) => {
      values.delete(key)
    },
    getSecret: async (key) => values.get(key),
    storeSecret: async (key, value) => {
      values.set(key, value)
    },
  })
  return values
}
afterEach(async () => {
  jest.restoreAllMocks()
  await Connection.dispose()
  await Session.clear()
  Session.configure(undefined)
})

test('a valid pairing can restore after the extension runtime is recreated', async () => {
  configure()
  const paired = options()
  Connection.set(paired)
  await Session.save(paired)
  await Connection.dispose()
  const restored = await Session.load()
  expect(restored).toEqual(paired)
  Connection.set(restored!)
  expect(() => Connection.assertWorkspace(paired.workspaceUri)).not.toThrow()
})

test('an account session without a fixed expiry restores after the extension runtime is recreated', async () => {
  const values = new Map<string, string>()
  Session.configure({
    deleteSecret: async (key) => {
      values.delete(key)
    },
    getAccountId: async () => 'owner',
    getSecret: async (key) => values.get(key),
    storeSecret: async (key, value) => {
      values.set(key, value)
    },
  })
  const paired = {
    account: true,
    accountId: 'owner',
    sessionToken: 'a'.repeat(64),
    websocketUrl: 'wss://remote.example/',
    workspaceUri: 'remote-server://remote.example/home/test/project',
  }
  await Session.save(paired)
  expect(await Session.load()).toEqual(paired)
})

test('switching away closes workspace connections without revoking the session needed by Open Recent', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
  configure()
  const paired = options()
  Connection.set(paired)
  await Session.save(paired)
  await Connection.releaseWorkspace(paired.workspaceUri)
  expect(Connection.getOptions()).toEqual(paired)
  expect(() => Connection.assertWorkspace(paired.workspaceUri)).not.toThrow()
})

for (const invalid of [
  { expiresAt: 1 },
  { websocketUrl: 'ws://public.example/' },
  { workspaceUri: 'remote-server://different.example/home' },
  { websocketUrl: 'wss://user:secret@remote.example/' },
]) {
  test(`invalid or expired saved pairing is removed: ${Object.keys(invalid)[0]}`, async () => {
    const values = configure()
    await Session.save({ ...options(), ...invalid })
    expect(await Session.load()).toBeUndefined()
    expect(values.size).toBe(0)
  })
}

test('explicit disconnect revokes access and removes the saved session', async () => {
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({}))
  const values = configure()
  const paired = options()
  Connection.set(paired)
  await Session.save(paired)
  await Connection.revoke()
  expect(values.size).toBe(0)
  expect(Connection.getOptions()).toBeUndefined()
  expect(fetch).toHaveBeenCalledWith(
    new URL('https://remote.example/auth/revoke'),
    expect.anything(),
  )
})

test('server rejection removes the saved session so reload cannot resurrect it', async () => {
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({}, { status: 401 }))
  const values = configure()
  const paired = options()
  Connection.set(paired)
  await Session.save(paired)
  await expect(
    Connection.getWebSocketUrl('file-system-process'),
  ).rejects.toThrow('HTTP 401')
  expect(values.size).toBe(0)
  await Connection.restore()
  expect(Connection.getOptions()).toBeUndefined()
})

test('disconnect still revokes remotely when clearing browser storage fails', async () => {
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({}))
  Session.configure({
    deleteSecret: async () => {
      throw new Error('Storage unavailable')
    },
    getSecret: async () => undefined,
    storeSecret: async () => {},
  })
  Connection.set(options())
  try {
    await Connection.revoke()
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://remote.example/auth/revoke'),
      expect.anything(),
    )
    expect(Connection.getOptions()).toBeUndefined()
  } finally {
    Session.configure(undefined)
  }
})

test('saved account sessions require the same signed-in account; manual sessions stay independent', async () => {
  const values = new Map<string, string>()
  let accountId = 'owner'
  Session.configure({
    deleteSecret: async (key) => {
      values.delete(key)
    },
    getAccountId: async () => accountId,
    getSecret: async (key) => values.get(key),
    storeSecret: async (key, value) => {
      values.set(key, value)
    },
  })
  const saved = { ...options(), account: true, accountId }
  await Session.save(saved)
  expect(await Session.load()).toEqual(saved)
  accountId = 'other'
  expect(await Session.load()).toBeUndefined()
  expect(values.size).toBe(0)
  await Session.save({ ...saved, accountId: 'owner' })
  accountId = ''
  expect(await Session.load()).toBeUndefined()
})
