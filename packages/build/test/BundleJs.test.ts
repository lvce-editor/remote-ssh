import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { bundleJs } from '../src/bundleJs.ts'
import { root } from '../src/root.ts'

const execFileAsync = promisify(execFile)

void test('preserves browser entry exports and replaces build constants after stripping TypeScript', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remote-ssh-browser-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const input = path.join(directory, 'main.ts')
  const outfile = path.join(directory, 'main.mjs')
  await writeFile(
    input,
    'declare const __VERSION__: string; export const version: string = __VERSION__',
  )

  await bundleJs({
    define: { __VERSION__: JSON.stringify('v1.2.3') },
    input,
    outfile,
    platform: 'browser',
  })

  const bundle = await import(pathToFileURL(outfile).href)
  strictEqual(bundle.version, 'v1.2.3')
})

void test('loads the bundled Node client and invokes a command', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remote-ssh-client-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const outfile = path.join(directory, 'remoteSshClient.mjs')

  await bundleJs({
    input: path.join(root, 'packages', 'node', 'src', 'remoteSshClient.ts'),
    outfile,
    platform: 'node',
  })

  const { commandMap } = await import(pathToFileURL(outfile).href)
  const hosts = await commandMap['SshConfigHosts.get']()
  strictEqual(Array.isArray(hosts), true)
})

void test('runs the bundled server with CommonJS dependencies and release metadata', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remote-ssh-server-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const outfile = path.join(directory, 'remoteSshServer.mjs')

  await bundleJs({
    define: { __LVCE_REMOTE_SSH_SERVER_VERSION__: JSON.stringify('v1.2.3') },
    input: path.join(root, 'packages', 'server', 'src', 'remoteSshServer.ts'),
    outfile,
    platform: 'node',
  })

  const { stdout } = await execFileAsync(process.execPath, [outfile, 'version'])
  deepStrictEqual(JSON.parse(stdout), {
    protocolVersion: 1,
    version: 'v1.2.3',
  })
})
