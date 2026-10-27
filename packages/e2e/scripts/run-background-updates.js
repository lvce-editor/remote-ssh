import { strictEqual } from 'node:assert/strict'
import { execFile, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { createSshServer } from 'e2e-helpers'
import { toRemoteSshUri } from '../../extension/src/parts/SshTarget/SshTarget.ts'

if (process.platform === 'linux') {
  const ssh = await createSshServer()
  const root = await mkdtemp(join(tmpdir(), 'lvce-background-update-'))
  const current = 'v0.24.0-editor-0.125.16'
  const old = 'v0.23.0-editor-0.125.16'
  const source = join(root, 'source')
  const archive = join(root, 'server.tar.gz')
  const backendScript = new URL(
    '../../../node_modules/@lvce-editor/server/src/server.js',
    import.meta.url,
  ).pathname
  const children = new Set()
  const oldServers = new Set()
  let artifactServer
  try {
    await mkdir(source)
    await build({
      bundle: true,
      entryPoints: [
        new URL('../../server/src/remoteSshServer.ts', import.meta.url)
          .pathname,
      ],
      outfile: join(source, 'lvce-remote-ssh-server.mjs'),
      platform: 'node',
      format: 'esm',
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      external: ['node:*'],
      define: {
        __LVCE_REMOTE_SSH_SERVER_VERSION__: JSON.stringify(current),
        __LVCE_REMOTE_SSH_EDITOR_VERSION__: JSON.stringify('0.125.16'),
      },
    })
    await promisify(execFile)('tar', ['-czf', archive, '-C', source, '.'])
    const bytes = await readFile(archive)
    let releaseDownload
    let requested
    let failDownload = false
    artifactServer = createServer(async (_request, response) => {
      requested?.()
      await new Promise((resolve) => {
        releaseDownload = resolve
      })
      response
        .writeHead(failDownload ? 500 : 200)
        .end(failDownload ? 'deliberate failure' : bytes)
    })
    await new Promise((resolve) =>
      artifactServer.listen(0, '127.0.0.1', resolve),
    )
    const url = `http://127.0.0.1:${artifactServer.address().port}/server.tar.gz`
    for (const mode of [
      'background',
      'cancel',
      'failure',
      'foreground',
      'first-install',
      'incompatible',
      'current',
    ]) {
      const remoteRoot = join(root, mode)
      const runtime = join(remoteRoot, 'runtimes', 'test-node', 'bin')
      await mkdir(runtime, { recursive: true })
      await symlink(process.execPath, join(runtime, 'node'))
      if (mode !== 'first-install') {
        const version =
          mode === 'current'
            ? current
            : mode === 'incompatible'
              ? 'v0.22.0-editor-0.125.16'
              : old
        const directory = join(remoteRoot, 'servers', version)
        const metadata = join(
          directory,
          'lvce-server/node_modules/@lvce-editor/server',
        )
        await mkdir(metadata, { recursive: true })
        await writeFile(
          join(directory, 'lvce-remote-ssh-server.mjs'),
          await readFile(join(source, 'lvce-remote-ssh-server.mjs')),
        )
        await writeFile(
          join(directory, 'remote-ssh-installation.json'),
          JSON.stringify({ serverVersion: version }),
        )
        await writeFile(
          join(metadata, 'package.json'),
          JSON.stringify({ version: '0.125.16' }),
        )
      }
      const requestedPromise = new Promise((resolve) => {
        requested = resolve
      })
      failDownload = mode === 'failure'
      const child = fork(
        new URL('./fixtures/background-update-client.js', import.meta.url),
        [toRemoteSshUri(ssh.fixture.target), mode],
        {
          env: {
            ...ssh.env,
            LVCE_REMOTE_SSH_REMOTE_ROOT: remoteRoot,
            LVCE_REMOTE_SSH_NODE_VERSION: 'test-node',
            LVCE_REMOTE_SSH_SERVER_VERSION: current,
            LVCE_REMOTE_SSH_SERVER_ARCHIVE_NAME: 'server.tar.gz',
            LVCE_REMOTE_SSH_SERVER_ARCHIVE_SHA256: createHash('sha256')
              .update(bytes)
              .digest('hex'),
            LVCE_REMOTE_SSH_SERVER_ARCHIVE_URL: url,
            LVCE_REMOTE_SSH_BACKEND_SCRIPT: backendScript,
          },
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        },
      )
      children.add(child)
      const messages = []
      const ready = new Promise((resolve) =>
        child.on('message', (message) => {
          messages.push(message)
          if (message.type === 'usable') resolve()
        }),
      )
      const exited = once(child, 'exit')
      const timeout = setTimeout(() => child.kill('SIGKILL'), 45000)
      try {
        if (mode === 'current') {
          const [code] = await exited
          strictEqual(code, 0)
          strictEqual(
            messages.some((message) => message.type === 'usable'),
            true,
          )
          console.log('PASS real SSH already-current')
          continue
        }
        const early = await Promise.race([
          requestedPromise.then(() => 'download'),
          exited.then(() => 'exit'),
        ])
        strictEqual(
          early,
          'download',
          `${mode}: exited before requesting archive`,
        )
        if (mode === 'background' || mode === 'failure' || mode === 'cancel') {
          const state = await Promise.race([
            ready.then(() => 'ready'),
            exited.then(() => 'exit'),
          ])
          strictEqual(state, 'ready', `${mode}: workspace blocked by download`)
          strictEqual(
            await readFile(
              join(ssh.fixture.workspacePath, 'during-update.txt'),
              'utf8',
            ),
            'saved before download finished',
          )
        } else {
          strictEqual(
            messages.some((message) => message.type === 'usable'),
            false,
            `${mode}: installation should block`,
          )
        }
        // Fail both the remote curl attempt and the bounded local-transfer path.
        if (failDownload) {
          artifactServer.removeAllListeners('request')
          artifactServer.on('request', (_request, response) =>
            response.writeHead(500).end('deliberate failure'),
          )
        }
        if (mode === 'cancel') child.send('cancel')
        releaseDownload()
        const [code] = await exited
        strictEqual(code, 0, `${mode}: client failed`)
        if (mode === 'background' || mode === 'failure')
          strictEqual(
            messages.some((message) => message.type === 'validated'),
            true,
          )
        console.log(
          `PASS real SSH ${mode}: ${JSON.stringify(messages.filter((message) => message.type === 'validated'))}`,
        )
      } finally {
        clearTimeout(timeout)
        child.kill('SIGKILL')
        children.delete(child)
        const run = join(remoteRoot, 'run')
        for (const entry of await readdir(run).catch(() => [])) {
          if (!entry.endsWith('.json')) continue
          const state = JSON.parse(await readFile(join(run, entry), 'utf8'))
          oldServers.add(state.pid)
          oldServers.add(state.backendPid)
        }
        for (const pid of oldServers) {
          try {
            process.kill(pid, 'SIGTERM')
          } catch {}
        }
        oldServers.clear()
      }
      // Recreate the delayed archive endpoint after the failure scenario.
      if (failDownload) {
        artifactServer.removeAllListeners('request')
        artifactServer.on('request', async (_request, response) => {
          requested?.()
          await new Promise((resolve) => {
            releaseDownload = resolve
          })
          response.end(bytes)
        })
      }
    }
  } finally {
    for (const child of children) child.kill('SIGKILL')
    for (const pid of oldServers) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
    }
    artifactServer?.closeAllConnections()
    artifactServer?.close()
    await ssh.dispose()
    await rm(root, { recursive: true, force: true })
  }
}
