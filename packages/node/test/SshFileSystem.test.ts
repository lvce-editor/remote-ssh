import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict'
import { test } from 'node:test'
import {
  _invoke,
  _sortDirents,
  _toFileUri,
  mkdir,
  remove,
  waitForOpenRequest,
} from '../src/parts/SshFileSystem/SshFileSystem.ts'

void test('converts remote POSIX paths to encoded file URIs', () => {
  strictEqual(
    _toFileUri('/home/user/project with spaces'),
    'file:///home/user/project%20with%20spaces',
  )
})

void test('invokes the existing remote file-system process', async () => {
  const calls: unknown[][] = []
  const result = await _invoke(
    'FileSystem.readFile',
    'remote-ssh://user@example.com/home/user/file.txt',
    ['base64'],
    async (...args) => {
      calls.push(args)
      return 'content'
    },
  )
  strictEqual(result, 'content')
  deepStrictEqual(calls, [
    [
      {
        identity: '["user","example.com",""]',
        path: '/home/user/file.txt',
        port: '',
        target: 'user@example.com',
      },
      'file-system-process',
      'FileSystem.readFile',
      'file:///home/user/file.txt',
      'base64',
    ],
  ])
})

void test('preserves sorting and legacy symbolic-link behavior', () => {
  deepStrictEqual(
    _sortDirents([
      { name: 'z-link', type: 9 },
      { name: 'a-folder', type: 3 },
    ]),
    [
      { name: 'a-folder', type: 3 },
      { name: 'z-link', type: 7 },
    ],
  )
})

void test('rejects root mutations before contacting the backend', () => {
  throws(() => mkdir('remote-ssh://example.com/'), /remote root/)
  throws(() => remove('remote-ssh://example.com/'), /remote root/)
})

void test('maps remote CLI folder requests onto the current SSH authority', async () => {
  const result = await waitForOpenRequest(
    'remote-ssh://user@example.com:2222/work',
    async (location) => {
      deepStrictEqual(location, {
        identity: '["user","example.com","2222"]',
        path: '/work',
        port: '2222',
        target: 'user@example.com',
      })
      return { kind: 'folder', path: '/home/project with spaces' }
    },
  )

  deepStrictEqual(result, {
    kind: 'folder',
    uri: 'remote-ssh://user@example.com:2222/home/project%20with%20spaces',
    workspaceUri:
      'remote-ssh://user@example.com:2222/home/project%20with%20spaces',
  })
})

void test('maps remote CLI files and their workspace folder', async () => {
  const result = await waitForOpenRequest(
    'remote-ssh://example.com/',
    async () => ({ kind: 'file', path: '/home/user/readme.md' }),
  )

  deepStrictEqual(result, {
    kind: 'file',
    uri: 'remote-ssh://example.com/home/user/readme.md',
    workspaceUri: 'remote-ssh://example.com/home/user',
  })
})
