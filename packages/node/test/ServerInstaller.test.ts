import { doesNotMatch, match, strictEqual } from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
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
  createTransferCommand,
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
  { skip: process.platform !== 'linux' || process.arch !== 'x64' },
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

    for (let index = 2; index <= 8; index++) {
      await runShell(
        createInstallScript({
          ...manifest,
          serverVersion: `test-server-${index}`,
        }),
        {
          ...process.env,
          HOME: home,
        },
      )
    }
    const installedServers = await readdir(
      path.join(home, '.lvce-server', 'servers'),
    )
    strictEqual(installedServers.length, 8)
    strictEqual(installedServers.includes('test-server'), true)
    strictEqual(installedServers.includes('test-server-8'), true)
    const reconnect = await runShell(createInstallScript(manifest), {
      ...process.env,
      HOME: home,
    })
    match(reconnect.stdout, new RegExp(installedMarker))
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

void test('can force the verified local transfer fallback', () => {
  const previous = process.env.LVCE_REMOTE_SSH_FORCE_LOCAL_TRANSFER
  process.env.LVCE_REMOTE_SSH_FORCE_LOCAL_TRANSFER = '1'
  try {
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
    match(script, /FORCE_LOCAL_TRANSFER=1/)
  } finally {
    if (previous === undefined) {
      delete process.env.LVCE_REMOTE_SSH_FORCE_LOCAL_TRANSFER
    } else {
      process.env.LVCE_REMOTE_SSH_FORCE_LOCAL_TRANSFER = previous
    }
  }
})

void test('transfers archives into the setup version directory', () => {
  const previous = process.env.LVCE_REMOTE_SSH_REMOTE_ROOT
  process.env.LVCE_REMOTE_SSH_REMOTE_ROOT = "/tmp/root with ' quote"
  try {
    const command = createTransferCommand(
      "version with ' quote",
      'server.tar.gz',
    )
    match(command, /version='version with '\\'' quote'/)
    match(command, /incoming="\$root\/incoming\/\$version"/)
    doesNotMatch(command, /incoming="\$root\/incoming\/'/)
  } finally {
    if (previous === undefined) {
      delete process.env.LVCE_REMOTE_SSH_REMOTE_ROOT
    } else {
      process.env.LVCE_REMOTE_SSH_REMOTE_ROOT = previous
    }
  }
})

void test(
  'upgrades the actual backend atomically, reuses it, and retains older clients on failure',
  { skip: process.platform !== 'linux' || process.arch !== 'x64' },
  async (context) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'lvce-installer-version-'),
    )
    context.after(() => rm(directory, { force: true, recursive: true }))
    const source = path.join(directory, 'source')
    const runtimeSource = path.join(source, 'node-test')
    await mkdir(path.join(runtimeSource, 'bin'), { recursive: true })
    await copyFile(process.execPath, path.join(runtimeSource, 'bin', 'node'))
    await chmod(path.join(runtimeSource, 'bin', 'node'), 0o755)
    const npmPath = path.join(
      runtimeSource,
      'lib',
      'node_modules',
      'npm',
      'bin',
    )
    await mkdir(npmPath, { recursive: true })
    // Controlled registry stand-in exercises the generated shell's real install path.
    await writeFile(
      path.join(npmPath, 'npm-cli.js'),
      `
    const fs = require('fs'); const path = require('path');
    const args = process.argv.slice(2);
    const version = args.at(-1).split('@').at(-1);
    if (version === '0.120.99') throw new Error('Matching backend unavailable');
    const prefix = args[args.indexOf('--prefix') + 1];
    fs.appendFileSync(process.env.INSTALL_LOG, version + '\\n');
    fs.writeFileSync(path.join(prefix, 'node_modules/@lvce-editor/server/package.json'), JSON.stringify({ version }));
  `,
    )
    const backend = path.join(
      source,
      'lvce-server',
      'node_modules',
      '@lvce-editor',
      'server',
    )
    await mkdir(backend, { recursive: true })
    await writeFile(
      path.join(backend, 'package.json'),
      JSON.stringify({ version: '0.120.9' }),
    )
    await writeFile(
      path.join(source, 'lvce-remote-ssh-server.mjs'),
      "if (process.argv[2] === 'version') process.stdout.write('ok\\n')",
    )
    const nodeArchive = path.join(directory, 'node.tar.gz')
    const serverArchive = path.join(directory, 'server.tar.gz')
    await execFileAsync('tar', ['-czf', nodeArchive, '-C', source, 'node-test'])
    await execFileAsync('tar', [
      '-czf',
      serverArchive,
      '-C',
      source,
      'lvce-server',
      'lvce-remote-ssh-server.mjs',
    ])
    const manifest: ServerManifest = {
      editorVersion: '0.120.10',
      nodeArchiveName: 'node.tar.gz',
      nodeArchiveSha256: await sha256(nodeArchive),
      nodeArchiveUrl: `file://${nodeArchive}`,
      nodeVersion: 'test-node',
      protocolVersion: 1,
      serverArchiveName: 'server.tar.gz',
      serverArchiveSha256: await sha256(serverArchive),
      serverArchiveUrl: `file://${serverArchive}`,
      serverVersion: 'ssh-editor-0.120.10',
    }
    const home = path.join(directory, 'home')
    await mkdir(home)
    const installLog = path.join(directory, 'installs.log')
    const env = { ...process.env, HOME: home, INSTALL_LOG: installLog }
    const serverRoot = path.join(home, '.lvce-server', 'servers')
    const previous = process.env.LVCE_REMOTE_SSH_REMOTE_ROOT
    delete process.env.LVCE_REMOTE_SSH_REMOTE_ROOT
    try {
      await runShell(
        createInstallScript({
          ...manifest,
          editorVersion: '0.120.9',
          serverVersion: 'ssh-editor-0.120.9',
        }),
        env,
      )
      await runShell(createInstallScript(manifest), env)
      const installed = JSON.parse(
        await readFile(
          path.join(
            serverRoot,
            manifest.serverVersion,
            'lvce-server/node_modules/@lvce-editor/server/package.json',
          ),
          'utf8',
        ),
      )
      strictEqual(installed.version, '0.120.10')
      await runShell(createInstallScript(manifest), env)
      strictEqual(await readFile(installLog, 'utf8'), '0.120.10\n')
      const { rejects } = await import('node:assert/strict')
      await rejects(
        runShell(
          createInstallScript({
            ...manifest,
            editorVersion: '0.120.99',
            serverVersion: 'ssh-editor-0.120.99',
          }),
          env,
        ),
        /Matching backend unavailable/,
      )
      const versions = await readdir(serverRoot)
      strictEqual(versions.includes('ssh-editor-0.120.9'), true)
      strictEqual(versions.includes('ssh-editor-0.120.10'), true)
      strictEqual(versions.includes('ssh-editor-0.120.99'), false)
      strictEqual(
        versions.some((value) => value.startsWith('.')),
        false,
      )
    } finally {
      if (previous === undefined) delete process.env.LVCE_REMOTE_SSH_REMOTE_ROOT
      else process.env.LVCE_REMOTE_SSH_REMOTE_ROOT = previous
    }
  },
)
