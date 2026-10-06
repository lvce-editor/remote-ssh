import { strictEqual } from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { createSshServer } from 'e2e-helpers'

const getSshProcesses = async (ownerPid) => {
  const pids = []
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue
    }
    try {
      const name = await readFile(`/proc/${entry}/comm`, 'utf8')
      const command = await readFile(`/proc/${entry}/cmdline`, 'utf8')
      if (
        name.trim() === 'ssh' &&
        command.includes(`lvce-remote-ssh-${ownerPid}-`)
      ) {
        pids.push(Number(entry))
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') {
        throw error
      }
    }
  }
  return pids
}

const portIsOpen = async (url) => {
  const { hostname, port } = new URL(url)
  return new Promise((resolve) => {
    const socket = createConnection({ host: hostname, port: Number(port) })
    const finish = (open) => {
      socket.destroy()
      resolve(open)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1000, () => finish(false))
  })
}

if (process.platform === 'linux') {
  const sshServer = await createSshServer()
  const root = await mkdtemp(join(tmpdir(), 'lvce-ssh-cleanup-'))
  try {
    const runtime = join(root, 'runtimes', 'test-node', 'bin')
    const server = join(root, 'servers', 'dev')
    await mkdir(runtime, { recursive: true })
    await mkdir(server, { recursive: true })
    await symlink(process.execPath, join(runtime, 'node'))
    await writeFile(
      join(server, 'lvce-remote-ssh-server.mjs'),
      `
      import { createServer } from 'node:net'
      const server = createServer(socket => socket.end('ready'))
      server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({
        arch: 'x64', backend: { port: server.address().port, token: 'test' },
        capabilities: ['fileSystemProcess', 'remoteCli', 'workspaceBackend'],
        clientVersion: 'dev', platform: 'linux', protocolVersion: 1, type: 'ready', version: 'dev',
      })))
      process.stdin.resume()
      process.stdin.on('end', () => process.exit(0))
    `,
    )
    for (const mode of process.argv.slice(2).length
      ? process.argv.slice(2)
      : ['dispose', 'disconnect', 'SIGTERM', 'SIGKILL']) {
      const child = fork(
        new URL('./fixtures/ssh-process-owner.js', import.meta.url),
        [sshServer.fixture.target, '--ipc-type=node-forked-process'],
        {
          env: {
            ...sshServer.env,
            LVCE_REMOTE_SSH_REMOTE_ROOT: root,
            LVCE_REMOTE_SSH_NODE_VERSION: 'test-node',
          },
          stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
        },
      )
      const ownerPid = child.pid
      const closed = once(child, 'exit')
      const output = createInterface({ input: child.stdout })
      try {
        const [chunk] = await once(output, 'line', {
          signal: AbortSignal.timeout(15000),
        })
        const backend = JSON.parse(String(chunk))
        strictEqual(await portIsOpen(backend.url), true)
        const before = await getSshProcesses(ownerPid)
        strictEqual(before.length > 0, true)
        const shutdown = once(child, 'exit', {
          signal: AbortSignal.timeout(5000),
        })
        if (mode === 'disconnect') {
          child.disconnect()
        } else if (mode === 'dispose') {
          child.stdin.end('dispose')
        } else {
          child.kill(mode)
        }
        await shutdown
        let remaining = []
        for (let attempt = 0; attempt < 50; attempt++) {
          remaining = await getSshProcesses(ownerPid)
          if (!remaining.length && !(await portIsOpen(backend.url))) {
            break
          }
          await delay(20)
        }
        console.log(
          `${mode}: SSH before=${before.join(',')} remaining=${remaining.join(',') || 'none'}`,
        )
        strictEqual(remaining.length, 0, `${mode} left SSH processes alive`)
        strictEqual(
          await portIsOpen(backend.url),
          false,
          `${mode} left a forwarding port open`,
        )
      } finally {
        output.close()
        child.kill('SIGKILL')
        await closed
        for (const pid of await getSshProcesses(ownerPid)) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch (error) {
            if (error.code !== 'ESRCH') {
              throw error
            }
          }
        }
      }
    }
  } finally {
    await sshServer.dispose()
    await rm(root, { recursive: true, force: true })
  }
}
