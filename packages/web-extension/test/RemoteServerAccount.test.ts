import { afterEach, expect, jest, test } from '@jest/globals'
import type { SetWorkspaceUri } from '../src/parts/RemoteServerConnect/RemoteServerConnect.ts'
const executeCommand =
  jest.fn<(...args: readonly unknown[]) => Promise<unknown>>()
const setUri = jest.fn<SetWorkspaceUri>(async () => {})
const showQuickPick = jest.fn<(...args: unknown[]) => Promise<unknown>>()
const Connect =
  await import('../src/parts/RemoteServerConnect/RemoteServerConnect.ts')
const Connection =
  await import('../src/parts/RemoteServerConnection/RemoteServerConnection.ts')
const Session =
  await import('../src/parts/RemoteServerSession/RemoteServerSession.ts')
const result = {
  authentication: 'websocket-ticket',
  capabilities: [
    'file-system-process',
    'file-watcher-explorer',
    'terminal-process',
    'search-process',
    'shared-process',
    'extension-node-process',
  ],
  protocolVersion: 1,
  sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  sessionToken: 'a'.repeat(64),
  websocketUrl: 'wss://remote.test/',
  workspacePath: '/project',
}
afterEach(async () => {
  jest.restoreAllMocks()
  jest.resetAllMocks()
  Session.configure(undefined)
  await Connection.dispose()
})
const configure = (): void => {
  executeCommand.mockImplementation(async (command) => {
    if (command === 'remote-server.getMachines')
      return {
        machines: [
          { browserAccess: true, disabled: false, hostname: 'remote.test' },
        ],
      }
    if (command === 'remote-server.authorizeBrowser')
      return {
        accountId: 'owner',
        authorization: 'one-use-grant',
        publicUrl: 'https://remote.test',
      }
    if (command === 'Workspace.setUri') return true
    throw new Error('unexpected command')
  })
}
test('a fresh browser connects from its LVCE account with no pairing input', async () => {
  configure()
  const fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json(result))
  await Connect.connectAccount(executeCommand, showQuickPick, setUri)
  expect(showQuickPick).not.toHaveBeenCalled()
  expect(fetchSpy).toHaveBeenCalledWith(
    new URL('https://remote.test/auth/account'),
    expect.objectContaining({
      headers: {
        authorization: 'Bearer one-use-grant',
        'x-lvce-protocol': '1',
      },
      method: 'POST',
    }),
  )
  expect(Connection.getOptions()).toMatchObject({
    account: true,
    accountId: 'owner',
    workspaceUri: 'remote-server://remote.test/project',
  })
  expect(setUri).toHaveBeenCalledWith(
    'remote-server://remote.test/project',
    '/',
    expect.objectContaining({ workspacePath: '/project' }),
  )
})
test('opening a workspace link in a new browser authorizes through its account without changing the workspace recursively', async () => {
  configure()
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(result))
  await expect(
    Connect.prepareWorkspace(
      'remote-server://remote.test/project',
      false,
      (host) => Connect.authorizeAccount(host, executeCommand),
    ),
  ).resolves.toMatchObject({ workspacePath: '/project' })
  expect(setUri).not.toHaveBeenCalled()
})
test('signing out while authorization is in flight discards the old account session', async () => {
  configure()
  const deferred = Promise.withResolvers<Response>()
  let started = false
  jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    started = true
    return deferred.promise
  })
  const pending = Connect.connectAccount(executeCommand, showQuickPick, setUri)
  for (let attempt = 0; attempt < 20 && !started; attempt++)
    await Promise.resolve()
  expect(started).toBe(true)
  await Connect.disconnectAccount()
  deferred.resolve(Response.json(result))
  await expect(pending).rejects.toThrow('workspace changed')
  expect(Connection.getOptions()).toBeUndefined()
})
test('a restarted server replaces the expired local session using the account', async () => {
  configure()
  Connection.set({
    account: true,
    accountId: 'owner',
    sessionToken: 'old',
    websocketUrl: 'wss://remote.test/',
    workspaceUri: 'remote-server://remote.test/project',
  })
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(Response.json(result))
  await expect(
    Connect.prepareWorkspace(
      'remote-server://remote.test/project',
      false,
      (host) => Connect.authorizeAccount(host, executeCommand),
    ),
  ).resolves.toMatchObject({ workspacePath: '/project' })
  expect(Connection.getOptions()?.sessionToken).toBe(result.sessionToken)
})

test('selects among account machines using the quick pick value', async () => {
  configure()
  executeCommand.mockImplementation(async (command, hostname) => {
    if (command === 'remote-server.getMachines')
      return {
        machines: ['first.test', 'remote.test'].map((host) => ({
          browserAccess: true,
          disabled: false,
          hostname: host,
        })),
      }
    if (command === 'remote-server.authorizeBrowser') {
      return {
        accountId: 'owner',
        authorization: 'grant',
        publicUrl: 'https://remote.test',
      }
    }
    return true
  })
  showQuickPick.mockResolvedValue('remote.test')
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(result))
  await Connect.connectAccount(executeCommand, showQuickPick, setUri)
  expect(executeCommand).toHaveBeenCalledWith(
    'remote-server.authorizeBrowser',
    'remote.test',
  )
  expect(Connection.getOptions()?.accountId).toBe('owner')
})

test('signing out revokes an account session saved before the current runtime was activated', async () => {
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
  await Session.save({
    account: true,
    accountId: 'owner',
    expiresAt: Date.now() + 60_000,
    sessionToken: 'a'.repeat(64),
    websocketUrl: 'wss://remote.test/',
    workspaceUri: 'remote-server://remote.test/project',
  })
  const fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ ok: true }))
  await Connect.disconnectAccount()
  expect(fetchSpy).toHaveBeenCalledWith(
    new URL('https://remote.test/auth/revoke'),
    expect.objectContaining({
      headers: { authorization: `Bearer ${'a'.repeat(64)}` },
    }),
  )
  expect(values.size).toBe(0)
  expect(Connection.getOptions()).toBeUndefined()
})
