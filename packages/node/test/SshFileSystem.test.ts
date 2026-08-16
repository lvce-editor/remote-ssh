import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict'
import { test } from 'node:test'
import {
  _invoke,
  _sortDirents,
  _toFileUri,
  mkdir,
  remove,
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
