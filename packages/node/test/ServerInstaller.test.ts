import { match, strictEqual } from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { ServerManifest } from '../src/parts/ServerManifest/ServerManifest.ts'
import {
  _escapeShell,
  createInstallScript,
  installedMarker,
  unsupportedMarker,
} from '../src/parts/ServerInstaller/ServerInstaller.ts'

const execFileAsync = promisify(execFile)

const sha256 = async (filePath: string): Promise<string> => {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex')
}

const runShell = (
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly stderr: string; readonly stdout: string }> => {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-s'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      const result = {
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      }
      if (code !== 0) {
        reject(new Error(result.stderr || result.stdout))
        return
      }
      resolve(result)
    })
    child.stdin.end(script)
  })
}

void test('escapes values passed to the remote shell', () => {
  strictEqual(_escapeShell("one'two"), "'one'\\''two'")
})

void test(
  'installs a private runtime and server atomically',
  { skip: process.platform === 'win32' },
  async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lvce-installer-'))
    context.after(() => rm(directory, { force: true, recursive: true }))
    const source = path.join(directory, 'source')
    const home = path.join(directory, 'home')
    const runtimeSource = path.join(source, 'node-test', 'bin')
    const nodeArchive = path.join(source, 'node.tar.gz')
    const serverArchive = path.join(source, 'server.tar.gz')
    await mkdir(runtimeSource, { recursive: true })
    await mkdir(home)
    await copyFile(process.execPath, path.join(runtimeSource, 'node'))
    await chmod(path.join(runtimeSource, 'node'), 0o755)
    await writeFile(
      path.join(source, 'lvce-remote-ssh-server.mjs'),
      "if (process.argv[2] === 'version') process.stdout.write('test\\n')\n",
    )
    await execFileAsync('tar', ['-czf', nodeArchive, '-C', source, 'node-test'])
    await execFileAsync('tar', [
      '-czf',
      serverArchive,
      '-C',
      source,
      'lvce-remote-ssh-server.mjs',
    ])
    const manifest: ServerManifest = {
      nodeArchiveName: 'node.tar.gz',
      nodeArchiveSha256: await sha256(nodeArchive),
      nodeArchiveUrl: `file://${nodeArchive}`,
      nodeVersion: 'test-node',
      protocolVersion: 1,
      serverArchiveName: 'server.tar.gz',
      serverArchiveSha256: await sha256(serverArchive),
      serverArchiveUrl: `file://${serverArchive}`,
      serverVersion: 'test-server',
    }

    const result = await runShell(createInstallScript(manifest), {
      ...process.env,
      HOME: home,
    })
    match(result.stdout, new RegExp(installedMarker))
    await chmod(
      path.join(home, '.lvce-server', 'runtimes', 'test-node', 'bin', 'node'),
      0o755,
    )
    const version = await execFileAsync(
      path.join(home, '.lvce-server', 'runtimes', 'test-node', 'bin', 'node'),
      [
        path.join(
          home,
          '.lvce-server',
          'servers',
          'test-server',
          'lvce-remote-ssh-server.mjs',
        ),
        'version',
      ],
    )
    strictEqual(version.stdout, 'test\n')
  },
)

void test('declares an explicit unsupported-platform marker', () => {
  const script = createInstallScript({
    nodeArchiveName: 'node.tar.gz',
    nodeArchiveSha256: 'node-sha',
    nodeArchiveUrl: 'https://example.com/node.tar.gz',
    nodeVersion: 'node',
    protocolVersion: 1,
    serverArchiveName: 'server.tar.gz',
    serverArchiveSha256: 'server-sha',
    serverArchiveUrl: 'https://example.com/server.tar.gz',
    serverVersion: 'server',
  })
  match(script, new RegExp(unsupportedMarker))
  match(script, /Linux:x86_64/)
  strictEqual(script.includes('python'), false)
})
