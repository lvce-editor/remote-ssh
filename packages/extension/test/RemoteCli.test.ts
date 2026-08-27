import { beforeEach, expect, jest, test } from '@jest/globals'
import { _reset, watch } from '../src/parts/RemoteCli/RemoteCli.ts'

beforeEach(() => {
  _reset()
})

test('switches folders in the current window and continues waiting', async () => {
  const workspaceUri = 'remote-ssh://host/home/project'
  const requests = [
    {
      kind: 'folder' as const,
      uri: workspaceUri,
      workspacePath: '/home/project',
      workspaceUri,
    },
  ]
  const wait = jest.fn(async (_workspaceUri: string) => {
    const request = requests.shift()
    if (!request) {
      return new Promise(() => {})
    }
    return request
  })
  const setWorkspace = jest.fn(async (_request: unknown) => {})

  watch('remote-ssh://host/', wait, setWorkspace)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(setWorkspace).toHaveBeenCalledWith({
    kind: 'folder',
    uri: workspaceUri,
    workspacePath: '/home/project',
    workspaceUri,
  })
  expect(wait).toHaveBeenCalledWith('remote-ssh://host/')
})

test('opens a file from the current workspace in the current window', async () => {
  const workspaceUri = 'remote-ssh://host/home'
  const uri = `${workspaceUri}/package.json`
  const requests = [
    {
      kind: 'file' as const,
      uri,
      workspacePath: '/home',
      workspaceUri,
    },
  ]
  const wait = jest.fn(async () => {
    const request = requests.shift()
    if (!request) {
      return new Promise(() => {})
    }
    return request
  })
  const setWorkspace = jest.fn(async (_request: unknown) => {})
  const openFile = jest.fn(async (_uri: string) => {})

  watch(workspaceUri, wait, setWorkspace, openFile)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  expect(openFile).toHaveBeenCalledWith(uri)
  expect(setWorkspace).not.toHaveBeenCalled()
})

test('opens a file after switching its parent workspace', async () => {
  const request = {
    kind: 'file' as const,
    uri: 'remote-ssh://host/other/readme.md',
    workspacePath: '/other',
    workspaceUri: 'remote-ssh://host/other',
  }
  const requests = [request]
  const wait = jest.fn(async () => {
    const next = requests.shift()
    if (!next) {
      return new Promise(() => {})
    }
    return next
  })
  const setWorkspace = jest.fn(async (_request: unknown) => {})
  const openFile = jest.fn(async (_uri: string) => {})

  watch('remote-ssh://host/home', wait, setWorkspace, openFile)
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }

  expect(setWorkspace).toHaveBeenCalledWith(request)
  expect(openFile).toHaveBeenCalledWith(request.uri)
  expect(setWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
    openFile.mock.invocationCallOrder[0],
  )
})

test('retries after a transient watcher failure', async () => {
  const workspaceUri = 'remote-ssh://host/home'
  const uri = `${workspaceUri}/package.json`
  let attempt = 0
  const wait = jest.fn(async () => {
    attempt++
    if (attempt === 1) {
      throw new Error('RPC replaced during workspace transition')
    }
    if (attempt === 2) {
      return {
        kind: 'file' as const,
        uri,
        workspacePath: '/home',
        workspaceUri,
      }
    }
    return new Promise(() => {})
  })
  const setWorkspace = jest.fn(async (_request: unknown) => {})
  const openFile = jest.fn(async (_uri: string) => {})
  const retryDelay = jest.fn(async () => {})

  watch(workspaceUri, wait, setWorkspace, openFile, retryDelay)
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
  }

  expect(retryDelay).toHaveBeenCalledTimes(1)
  expect(openFile).toHaveBeenCalledWith(uri)
  expect(wait).toHaveBeenCalledTimes(3)
})

test('ignores duplicate watchers for one workspace', async () => {
  const wait = jest.fn(async () => new Promise(() => {}))
  const setWorkspace = jest.fn(async (_request: unknown) => {})

  watch('remote-ssh://host/', wait, setWorkspace)
  watch('remote-ssh://host/', wait, setWorkspace)
  await Promise.resolve()

  expect(wait).toHaveBeenCalledTimes(1)
})
