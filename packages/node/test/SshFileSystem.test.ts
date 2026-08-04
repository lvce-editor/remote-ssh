import { rejects } from 'node:assert/strict'
import { test } from 'node:test'
import { rename } from '../src/parts/SshFileSystem/SshFileSystem.ts'

void test('rejects cross-host renames before invoking SSH', async () => {
  await rejects(
    rename(
      'remote-ssh://one.example.com/file',
      'remote-ssh://two.example.com/file',
    ),
    /Cannot rename across SSH hosts/,
  )
})
