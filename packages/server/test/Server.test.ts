import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { strictEqual } from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

interface ServerState {
  readonly pid: number
}

const entry = path.join(import.meta.dirname, '..', 'src', 'remoteSshServer.ts')

const readLine = (child: ChildProcessWithoutNullStreams): Promise<string> => {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const index = buffer.indexOf('\n')
      if (index !== -1) {
        child.stdout.off('data', onData)
        resolve(buffer.slice(0, index))
      }
    }
    child.stdout.on('data', onData)
    child.once('error', reject)
  })
}

const connect = async (
  root: string,
): Promise<ChildProcessWithoutNullStreams> => {
  const child = spawn(process.execPath, [entry, 'connect-or-start'], {
    env: {
      ...process.env,
      LVCE_REMOTE_SSH_IDLE_TIMEOUT: '200',
      LVCE_REMOTE_SSH_ROOT: root,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const ready = JSON.parse(await readLine(child)) as {
    readonly protocolVersion: number
    readonly type: string
  }
  strictEqual(ready.type, 'ready')
  strictEqual(ready.protocolVersion, 1)
  return child
}

const stopConnector = async (
  child: ChildProcessWithoutNullStreams,
): Promise<void> => {
  child.stdin.end()
  await new Promise<void>((resolve) => child.once('close', () => resolve()))
}

void test(
  'reuses a detached daemon across connector processes',
  { skip: process.platform === 'win32' },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lvce-server-'))
    const statePath = path.join(root, 'run', 'server-dev.json')
    context.after(async () => {
      try {
        const state = JSON.parse(
          await readFile(statePath, 'utf8'),
        ) as ServerState
        process.kill(state.pid, 'SIGTERM')
      } catch {
        // The idle timeout may already have stopped the daemon.
      }
      await rm(root, { force: true, recursive: true })
    })

    const first = await connect(root)
    const firstState = JSON.parse(
      await readFile(statePath, 'utf8'),
    ) as ServerState
    await stopConnector(first)

    const second = await connect(root)
    const secondState = JSON.parse(
      await readFile(statePath, 'utf8'),
    ) as ServerState
    strictEqual(secondState.pid, firstState.pid)

    second.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: 'fileSystem',
        params: { operation: 'connect', path: root },
      })}\n`,
    )
    const response = JSON.parse(await readLine(second)) as {
      readonly id: number
    }
    strictEqual(response.id, 1)
    await stopConnector(second)
  },
)

void test(
  'recovers from stale daemon state',
  { skip: process.platform === 'win32' },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lvce-server-stale-'))
    const runDirectory = path.join(root, 'run')
    const statePath = path.join(runDirectory, 'server-dev.json')
    await mkdir(runDirectory, { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        pid: 999_999,
        protocolVersion: 1,
        socketPath: path.join(runDirectory, 'missing.sock'),
        token: 'stale',
        version: 'dev',
      }),
    )
    context.after(async () => {
      try {
        const state = JSON.parse(
          await readFile(statePath, 'utf8'),
        ) as ServerState
        process.kill(state.pid, 'SIGTERM')
      } catch {
        // The idle timeout may already have stopped the daemon.
      }
      await rm(root, { force: true, recursive: true })
    })

    const connector = await connect(root)
    const state = JSON.parse(await readFile(statePath, 'utf8')) as ServerState
    strictEqual(state.pid === 999_999, false)
    await stopConnector(connector)
  },
)
