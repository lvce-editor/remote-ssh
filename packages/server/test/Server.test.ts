import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

interface ServerState {
  readonly backendPid: number
  readonly pid: number
}

const stopState = (state: ServerState): void => {
  try {
    process.kill(state.backendPid, 'SIGTERM')
  } catch {
    // Already stopped.
  }
  try {
    process.kill(state.pid, 'SIGKILL')
  } catch {
    // Already stopped.
  }
}

const entry = path.join(import.meta.dirname, '..', 'src', 'remoteSshServer.ts')
const backendEntry = path.join(
  import.meta.dirname,
  'fixtures',
  'workspaceBackend.ts',
)

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
      LVCE_REMOTE_SSH_IDLE_TIMEOUT: '2000',
      LVCE_REMOTE_SSH_BACKEND_SCRIPT: backendEntry,
      LVCE_REMOTE_SSH_ROOT: root,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const ready = JSON.parse(await readLine(child)) as {
    readonly backend: { readonly port: number; readonly token: string }
    readonly capabilities: readonly string[]
    readonly protocolVersion: number
    readonly type: string
  }
  strictEqual(ready.type, 'ready')
  strictEqual(ready.protocolVersion, 1)
  strictEqual(Number.isSafeInteger(ready.backend.port), true)
  strictEqual(typeof ready.backend.token, 'string')
  strictEqual(ready.capabilities.includes('workspaceBackend'), true)
  strictEqual(ready.capabilities.includes('fileSystemProcess'), true)
  strictEqual(ready.capabilities.includes('remoteCli'), true)
  return child
}

const stopConnector = async (
  child: ChildProcessWithoutNullStreams,
): Promise<void> => {
  child.stdin.end()
  await new Promise<void>((resolve) => child.once('close', () => resolve()))
}

const run = async (
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> => {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderr: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (code !== 0) {
    throw new Error(Buffer.concat(stderr).toString('utf8'))
  }
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
        stopState(state)
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
    strictEqual(secondState.backendPid, firstState.backendPid)

    await stopConnector(second)
  },
)

void test(
  'relays the installed remote lvce command to the connector',
  { skip: process.platform === 'win32' },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lvce-server-cli-'))
    const statePath = path.join(root, 'run', 'server-dev.json')
    context.after(async () => {
      try {
        const state = JSON.parse(
          await readFile(statePath, 'utf8'),
        ) as ServerState
        stopState(state)
      } catch {
        // The idle timeout may already have stopped the daemon.
      }
      await rm(root, { force: true, recursive: true })
    })

    const connector = await connect(root)
    const openRequestPromise = readLine(connector)
    await run(path.join(root, 'bin', 'lvce'), ['/home'], root)

    deepStrictEqual(JSON.parse(await openRequestPromise), {
      kind: 'folder',
      path: '/home',
      type: 'open',
    })
    await stopConnector(connector)
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
        stopState(state)
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
