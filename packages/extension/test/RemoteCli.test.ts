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

  watch('remote-ssh://host/', wait, open)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(open).toHaveBeenCalledWith(
    `/?workspace=${encodeURIComponent('remote-ssh://host/home')}`,
  )
  expect(wait).toHaveBeenCalledWith('remote-ssh://host/')
})

test('ignores duplicate watchers for one workspace', async () => {
  const wait = jest.fn(async () => new Promise(() => {}))
  const open = jest.fn(async (_url: string) => {})

  watch('remote-ssh://host/', wait, open)
  watch('remote-ssh://host/', wait, open)
  await Promise.resolve()

  expect(wait).toHaveBeenCalledTimes(1)
})
