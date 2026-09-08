import { deepStrictEqual, rejects } from 'node:assert/strict'
import { test } from 'node:test'
import { request } from '../src/parts/SshWorkspace/SshWorkspace.ts'

void test('routes remote searches and terminal discovery through the SSH transport', async () => {
  const calls: unknown[][] = []
  const invoke = async (...args: readonly unknown[]): Promise<unknown> => {
    calls.push([...args])
    return args[2] === 'SearchFile.searchFile'
      ? 'file one.txt\nfolder/file.txt\n'
      : { limitHit: true, results: [] }
  }
  deepStrictEqual(
    await request(
      'remote-ssh://host/work/my%20folder',
      'text-search',
      ['--json', 'needle'],
      invoke,
    ),
    { limitHit: true, results: [] },
  )
  deepStrictEqual(calls[0]?.slice(1), [
    'search-process',
    'TextSearch.search',
    { ripGrepArgs: ['--json', 'needle'], searchDir: '/work/my folder' },
  ])
  deepStrictEqual(
    await request('remote-ssh://host/work', 'file-search', [], invoke),
    ['file one.txt', 'folder/file.txt'],
  )
  await request('remote-ssh://host/work', 'terminal-options', [], invoke)
  deepStrictEqual(calls[2]?.slice(1), [
    'shared-process',
    'GetTerminalSpawnOptions.getTerminalSpawnOptions',
  ])
  await rejects(
    request('remote-ssh://host/work', 'shared-process', [], invoke),
    /Unsupported/,
  )
})
