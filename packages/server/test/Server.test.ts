import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

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

const startConnector = (
  root: string,
  environment: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams => {
  return spawn(process.execPath, [entry, 'connect-or-start'], {
    env: {
      ...process.env,
      LVCE_REMOTE_SSH_IDLE_TIMEOUT: '2000',
      LVCE_REMOTE_SSH_BACKEND_SCRIPT: backendEntry,
      LVCE_REMOTE_SSH_ROOT: root,
      LVCE_REMOTE_SSH_TEST_OPEN_REQUEST_PATH: path.join(
        root,
        'open-request.json',
      ),
      ...environment,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

const connect = async (
  root: string,
): Promise<ChildProcessWithoutNullStreams> => {
  const child = startConnector(root)
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
  'relays the installed remote lvce command directly to the SSH extension',
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
    const request = readLine(connector)
    await run(path.join(root, 'bin', 'dev', 'lvce'), ['/home'], root)

    deepStrictEqual(JSON.parse(await request), {
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

void test(
  'disconnects clients and replaces a daemon whose backend crashed',
  { skip: process.platform === 'win32', timeout: 10_000 },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lvce-server-crash-'))
    const statePath = path.join(root, 'run', 'server-dev.json')
    const states: ServerState[] = []
    const connectors: ChildProcessWithoutNullStreams[] = []
    context.after(async () => {
      for (const connector of connectors) {
        connector.kill()
      }
      for (const state of states) {
        stopState(state)
      }
      await rm(root, { force: true, recursive: true })
    })
    const first = await connect(root)
    connectors.push(first)
    const firstState = JSON.parse(
      await readFile(statePath, 'utf8'),
    ) as ServerState
    states.push(firstState)
    const disconnected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The daemon kept the dead backend connected')),
        1500,
      )
      first.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    process.kill(firstState.backendPid, 'SIGKILL')
    await disconnected
    // Shutdown removes the stale state after closing the management connection.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await readFile(statePath).catch(() => undefined))) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const second = await connect(root)
    connectors.push(second)
    const secondState = JSON.parse(
      await readFile(statePath, 'utf8'),
    ) as ServerState
    states.push(secondState)
    strictEqual(secondState.pid === firstState.pid, false)
    strictEqual(secondState.backendPid === firstState.backendPid, false)
    await stopConnector(second)
  },
)

const waitFor = async (predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 2000
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for startup cancellation')
    }
    await delay(10)
  }
}

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

for (const cancellation of ['stdin', 'SIGTERM', 'SIGKILL'] as const) {
  void test(
    `cancels an unpublished daemon on ${cancellation}`,
    { skip: process.platform === 'win32', timeout: 8000 },
    async (context) => {
      const root = await mkdtemp(path.join(tmpdir(), 'lvce-server-cancel-'))
      const gate = path.join(root, 'startup-gate')
      const statePath = path.join(root, 'run', 'server-dev.json')
      const connectors: ChildProcessWithoutNullStreams[] = []
      const readStarted = async (): Promise<ServerState[]> => {
        const text = await readFile(`${gate}.started`, 'utf8').catch(() => '')
        return text.trim()
          ? text
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as ServerState)
          : []
      }
      context.after(async () => {
        for (const connector of connectors) connector.kill('SIGKILL')
        for (const state of await readStarted()) stopState(state)
        await rm(root, { force: true, recursive: true })
      })
      await writeFile(gate, '')
      const first = startConnector(root, {
        LVCE_REMOTE_SSH_TEST_STARTUP_GATE: gate,
      })
      connectors.push(first)
      await waitFor(async () => (await readStarted()).length === 1)
      const [started] = await readStarted()
      if (cancellation === 'stdin') first.stdin.end()
      else first.kill(cancellation)
      await waitFor(async () => !isRunning(started.backendPid))
      await waitFor(
        async () => first.exitCode !== null || first.signalCode !== null,
      )
      // Releasing the gate must not let the canceled backend publish readiness.
      await rm(gate)
      strictEqual(await readFile(statePath).catch(() => undefined), undefined)
      // SIGKILL leaves the existing stale-lock recovery policy in effect.
      if (cancellation === 'SIGKILL') return
      const retry = await connect(root)
      connectors.push(retry)
      const state = JSON.parse(await readFile(statePath, 'utf8')) as ServerState
      strictEqual(state.backendPid === started.backendPid, false)
      await stopConnector(retry)
      stopState(state)
    },
  )
}

for (const cancelOwner of [false, true]) {
  void test(
    `preserves a concurrent connector when the ${cancelOwner ? 'startup owner' : 'waiter'} cancels`,
    { skip: process.platform === 'win32', timeout: 8000 },
    async (context) => {
      const root = await mkdtemp(path.join(tmpdir(), 'lvce-server-concurrent-'))
      const gate = path.join(root, 'startup-gate')
      const statePath = path.join(root, 'run', 'server-dev.json')
      const connectors: ChildProcessWithoutNullStreams[] = []
      const readStarted = async (): Promise<ServerState[]> => {
        const text = await readFile(`${gate}.started`, 'utf8').catch(() => '')
        return text.trim()
          ? text
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as ServerState)
          : []
      }
      context.after(async () => {
        for (const connector of connectors) connector.kill('SIGKILL')
        for (const state of await readStarted()) stopState(state)
        await rm(root, { force: true, recursive: true })
      })
      await writeFile(gate, '')
      const first = startConnector(root, {
        LVCE_REMOTE_SSH_TEST_STARTUP_GATE: gate,
      })
      connectors.push(first)
      await waitFor(async () => (await readStarted()).length === 1)
      const [original] = await readStarted()
      const second = startConnector(root, {
        LVCE_REMOTE_SSH_TEST_STARTUP_GATE: gate,
      })
      connectors.push(second)
      const canceled = cancelOwner ? first : second
      const survivor = cancelOwner ? second : first
      const ready = readLine(survivor)
      canceled.stdin.end()
      await waitFor(
        async () => canceled.exitCode !== null || canceled.signalCode !== null,
      )
      if (cancelOwner) {
        await waitFor(async () => (await readStarted()).length === 2)
        strictEqual(isRunning(original.backendPid), false)
      } else {
        strictEqual(isRunning(original.backendPid), true)
        strictEqual((await readStarted()).length, 1)
      }
      await rm(gate)
      strictEqual((JSON.parse(await ready) as { type: string }).type, 'ready')
      const state = JSON.parse(await readFile(statePath, 'utf8')) as ServerState
      strictEqual(state.backendPid === original.backendPid, !cancelOwner)
      const third = await connect(root)
      connectors.push(third)
      await stopConnector(survivor)
      strictEqual(isRunning(state.backendPid), true)
      strictEqual(third.exitCode, null)
      await stopConnector(third)
    },
  )
}
