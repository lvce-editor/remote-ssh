import { beforeEach, expect, jest, test } from '@jest/globals'
import {
  _reset,
  getWindowUrl,
  watch,
} from '../src/parts/RemoteCli/RemoteCli.ts'

beforeEach(() => {
  _reset()
})

test('builds a remote folder workspace URL', () => {
  const workspaceUri = 'remote-ssh://host/home'
  expect(
    getWindowUrl({
      kind: 'folder',
      uri: workspaceUri,
      workspaceUri,
    }),
  ).toBe(`/?workspace=${encodeURIComponent(workspaceUri)}`)
})

test('builds a remote file and parent workspace URL', () => {
  const uri = 'remote-ssh://host/home/readme.md'
  const workspaceUri = 'remote-ssh://host/home'
  expect(
    getWindowUrl({
      kind: 'file',
      uri,
      workspaceUri,
    }),
  ).toBe(
    `/?workspace=${encodeURIComponent(workspaceUri)}&openUri=${encodeURIComponent(uri)}`,
  )
})

test('opens requests and continues waiting', async () => {
  const requests = [
    {
      kind: 'folder' as const,
      uri: 'remote-ssh://host/home',
      workspaceUri: 'remote-ssh://host/home',
    },
  ]
  const wait = jest.fn(async (_workspaceUri: string) => {
    const request = requests.shift()
    if (!request) {
      return new Promise(() => {})
    }
    return request
  })
  const open = jest.fn(async (_url: string) => {})
  const log = jest.fn(async (_message: string) => {})

  watch('remote-ssh://host/', wait, open, undefined, undefined, log)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(open).toHaveBeenCalledWith(
    `/?workspace=${encodeURIComponent('remote-ssh://host/home')}`,
  )
  expect(wait).toHaveBeenCalledWith('remote-ssh://host/')
})

test('logs workspace switches and skips files in the current workspace', async () => {
  const workspaceUri = 'remote-ssh://host/home'
  const nextWorkspaceUri = 'remote-ssh://host/home/project'
  const anotherWorkspaceUri = 'remote-ssh://host/home/another-project'
  const requests = [
    {
      kind: 'folder' as const,
      uri: nextWorkspaceUri,
      workspaceUri: nextWorkspaceUri,
    },
    {
      kind: 'folder' as const,
      uri: anotherWorkspaceUri,
      workspaceUri: anotherWorkspaceUri,
    },
    {
      kind: 'file' as const,
      uri: `${workspaceUri}/package.json`,
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
  const log = jest.fn(async (_message: string) => {})
  const open = jest.fn(async (_url: string) => {})
  const openFile = jest.fn(async (_uri: string) => {})

  watch(workspaceUri, wait, open, openFile, async () => {}, log)
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }

  expect(log).toHaveBeenCalledTimes(2)
  expect(log).toHaveBeenNthCalledWith(
    1,
    `Switching SSH workspace to ${nextWorkspaceUri}`,
  )
  expect(log).toHaveBeenNthCalledWith(
    2,
    `Switching SSH workspace to ${anotherWorkspaceUri}`,
  )
  expect(openFile).toHaveBeenCalledWith(`${workspaceUri}/package.json`)
})

test('opens a file from the current workspace in the current window', async () => {
  const workspaceUri = 'remote-ssh://host/home'
  const uri = `${workspaceUri}/package.json`
  const requests = [
    {
      kind: 'file' as const,
      uri,
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
  const openWindow = jest.fn(async (_url: string) => {})
  const openFile = jest.fn(async (_uri: string) => {})

  watch(workspaceUri, wait, openWindow, openFile)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  expect(openFile).toHaveBeenCalledWith(uri)
  expect(openWindow).not.toHaveBeenCalled()
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
      return { kind: 'file' as const, uri, workspaceUri }
    }
    return new Promise(() => {})
  })
  const openWindow = jest.fn(async (_url: string) => {})
  const openFile = jest.fn(async (_uri: string) => {})
  const retryDelay = jest.fn(async () => {})

  watch(workspaceUri, wait, openWindow, openFile, retryDelay)
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
  }

  expect(retryDelay).toHaveBeenCalledTimes(1)
  expect(openFile).toHaveBeenCalledWith(uri)
  expect(wait).toHaveBeenCalledTimes(3)
})

test('ignores duplicate watchers for one workspace', async () => {
  const wait = jest.fn(async () => new Promise(() => {}))
  const open = jest.fn(async (_url: string) => {})

  watch('remote-ssh://host/', wait, open)
  watch('remote-ssh://host/', wait, open)
  await Promise.resolve()

  expect(wait).toHaveBeenCalledTimes(1)
})
