import { strictEqual } from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { getRemoteSshProcessBuildOptions } from '../src/getRemoteSshProcessBuildOptions.js'
import { root } from '../src/root.js'

void test('builds the node process declared by the extension manifest', async () => {
  const extension = path.join(root, 'packages', 'extension')
  const outdir = path.join(extension, 'dist')
  const options = getRemoteSshProcessBuildOptions({
    define: {},
    outdir,
  })
  const manifest = JSON.parse(
    await readFile(path.join(extension, 'extension.json'), 'utf8'),
  )
  const rpc = manifest.rpc.find(
    (candidate) => candidate.id === 'builtin.remote-ssh.node',
  )
  const relativeOutput = path
    .relative(extension, options.outfile)
    .split(path.sep)
    .join('/')

  strictEqual(relativeOutput, rpc.url)
  strictEqual(
    options.entryPoints[0],
    path.join(root, 'packages', 'node', 'src', 'remoteSshProcess.ts'),
  )
})
