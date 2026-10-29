import { afterEach, expect, jest, test } from '@jest/globals'
import * as Connection from '../src/parts/RemoteServerConnection/RemoteServerConnection.ts'
import {
  resolveHttpPreview,
  revokePreviews,
} from '../src/parts/RemoteServerConnection/RemoteHttpPreview.ts'

const workspace = 'remote-server://remote.example.com/workspace'
const base = `https://remote.example.com/preview/${'a'.repeat(64)}/`
afterEach(async () => {
  jest.restoreAllMocks()
  await Connection.dispose()
})
const connect = () =>
  Connection.set({
    sessionToken: 'workspace-secret',
    websocketUrl: 'wss://remote.example.com/',
    workspaceUri: workspace,
  })

test('preserves loopback path, query and fragment without exposing the workspace bearer', async () => {
  connect()
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue({
      ok: true,
      json: async () => ({ previewUrl: base }),
    } as Response)
  await expect(
    resolveHttpPreview(
      workspace + '/nested',
      'http://localhost:8080/a%20b?q=one%20two#part',
    ),
  ).resolves.toBe(base + 'a%20b?q=one%20two#part')
  expect(fetchMock).toHaveBeenCalledWith(
    new URL(
      'https://remote.example.com/auth/http-preview?port=8080&protocol=http%3A',
    ),
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      headers: { authorization: 'Bearer workspace-secret' },
    }),
  )
  fetchMock.mockResolvedValue({ ok: true } as Response)
  await revokePreviews(Connection.getOptions()!)
  expect(fetchMock).toHaveBeenLastCalledWith(
    new URL('https://remote.example.com/auth/revoke-previews'),
    expect.objectContaining({ method: 'POST' }),
  )
})

test('rejects another workspace and non-loopback targets before requesting a grant', async () => {
  connect()
  const spy = jest.spyOn(globalThis, 'fetch')
  await expect(
    resolveHttpPreview(
      'remote-server://other.example.com/workspace',
      'http://localhost:8080',
    ),
  ).rejects.toThrow('not connected')
  await expect(
    resolveHttpPreview(
      'remote-server://remote.example.com/workspace-other',
      'http://localhost:8080',
    ),
  ).rejects.toThrow('not connected')
  for (const url of [
    'https://example.com',
    'file:///etc/passwd',
    'http://user:password@localhost:8080',
  ])
    await expect(resolveHttpPreview(workspace, url)).rejects.toThrow('loopback')
  expect(spy).not.toHaveBeenCalled()
})

test('rejects an untrusted preview endpoint and a changed workspace', async () => {
  connect()
  const spy = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        previewUrl: base.replace('remote.example.com', 'evil.example.com'),
      }),
    } as Response)
  await expect(
    resolveHttpPreview(workspace, 'http://127.0.0.1:8080'),
  ).rejects.toThrow('Invalid remote preview endpoint')
  spy.mockImplementation(async () => {
    connect()
    return { ok: true, json: async () => ({ previewUrl: base }) } as Response
  })
  await expect(
    resolveHttpPreview(workspace, 'http://[::1]:8080'),
  ).rejects.toThrow('Workspace changed')
})
