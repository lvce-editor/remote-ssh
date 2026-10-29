import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { dirname, join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)

export interface ContainerBackend {
  readonly port: number
  readonly token: string
  readonly workspacePath: string
  readonly close: () => Promise<void>
  readonly terminal?: (cwd: string) => Promise<{
    cwd: string
    command: string
    args: string[]
    dispose: () => Promise<void>
  }>
}

/** Keep lifecycle/configuration handling in the shipped Dev Containers extension. */
export const openContainer = async (
  installation: string,
  workspaceFolder: string,
  signal: AbortSignal,
): Promise<ContainerBackend> => {
  const moduleUrl = pathToFileURL(
    join(
      installation,
      'lvce-server',
      'extensions',
      'builtin.devcontainer',
      'dist',
      'devcontainerWorkerModule.js',
    ),
  )
  const { commandMap } = await import(moduleUrl.href)
  signal.throwIfAborted()
  const result = await commandMap['DevContainer.openWorkspace']({
    workspaceFolder,
  })
  if (!result?.ok)
    throw new Error(result?.errorMessage || 'Could not start the devcontainer')
  signal.throwIfAborted()
  const state = await commandMap['DevContainer.getState']({ workspaceFolder })
  if (
    !/^[a-f0-9]{12,64}$/.test(state.containerId) ||
    !state.remoteWorkspaceFolder?.startsWith('/')
  )
    throw new Error('Devcontainer returned an invalid workspace')
  const cli = state.containerCli || 'docker'
  const user = state.remoteUser ? ['--user', state.remoteUser] : []
  const directory = `/tmp/lvce-tunnel-${randomBytes(16).toString('hex')}`
  const run = async (args: string[], timeout = 120_000) =>
    execute(cli, args, { signal, timeout, maxBuffer: 1024 * 1024 })
  const inside = async (args: string[]) =>
    run(['exec', ...user, state.containerId, ...args])
  const sockets = new Set<Socket>()
  const children = new Set<ReturnType<typeof spawn>>()
  const proxy = createServer((socket) => {
    sockets.add(socket)
    const bridge = spawn(
      cli,
      [
        'exec',
        '-i',
        ...user,
        state.containerId,
        `${directory}/node`,
        '--input-type=commonjs',
        '-e',
        'const s=require("node:net").connect(Number(process.argv[1]),"127.0.0.1");s.on("error",()=>process.exit(1));process.stdin.pipe(s);s.pipe(process.stdout);s.on("close",()=>process.exit());',
        String(port),
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    )
    children.add(bridge)
    socket.pipe(bridge.stdin)
    bridge.stdout.pipe(socket)
    bridge.stdin.on('error', () => socket.destroy())
    bridge.on('error', () => socket.destroy())
    bridge.on('exit', () => {
      children.delete(bridge)
      socket.destroy()
    })
    socket.on('error', () => socket.destroy())
    socket.once('close', () => {
      sockets.delete(socket)
      bridge.kill()
    })
  })
  let port = 0
  const token = randomBytes(32).toString('hex')
  let backend: ReturnType<typeof spawn> | undefined
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', abort)
    for (const socket of sockets) socket.destroy()
    for (const child of children) child.kill()
    if (proxy.listening)
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    // Kill only this backend, never the user's container or another window's server.
    await execute(
      cli,
      [
        'exec',
        ...user,
        state.containerId,
        'sh',
        '-c',
        'if test -f "$1/pid"; then kill "$(cat "$1/pid")" 2>/dev/null || true; fi; rm -rf -- "$1"',
        'lvce-cleanup',
        directory,
      ],
      { timeout: 10_000 },
    ).catch(() => {})
    backend?.kill()
  }
  const abort = (): void => {
    void close()
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    await inside(['mkdir', '-m', '700', directory])
    await run([
      'cp',
      process.execPath,
      `${state.containerId}:${directory}/node`,
    ])
    await run([
      'cp',
      join(installation, 'lvce-server'),
      `${state.containerId}:${directory}/server`,
    ])
    // docker cp preserves host ownership. Make copied runtime readable by remoteUser.
    await run([
      'exec',
      '--user',
      '0',
      state.containerId,
      'chmod',
      '-R',
      'a+rX',
      directory,
    ])
    signal.throwIfAborted()
    backend = spawn(
      cli,
      [
        'exec',
        '-i',
        ...user,
        '--workdir',
        state.remoteWorkspaceFolder,
        '--env',
        `BUILTIN_EXTENSIONS_PATH=${directory}/server/extensions`,
        '--env',
        `LVCE_REMOTE_EXTENSIONS_PATH=${directory}/server/extensions`,
        state.containerId,
        'sh',
        '-c',
        'echo $$ > "$1/pid"; shift; exec "$@"',
        'lvce-server',
        directory,
        `${directory}/node`,
        `${directory}/server/node_modules/@lvce-editor/server/src/server.js`,
        '--as-remote-ssh-server',
        `--port=${port}`,
        `--connection-token=${token}`,
        '--idle-timeout=600000',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let output = ''
    backend.stdout!.on('data', (data: Buffer) => {
      output = (output + data.toString()).slice(-8192)
      const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) port = Number(match[1])
    })
    let failure = ''
    backend.stderr!.on('data', (data: Buffer) => {
      failure = (failure + data.toString()).slice(-4096)
    })
    backend.on('error', (error) => {
      failure = error.message
    })
    const deadline = Date.now() + 30_000
    while (true) {
      signal.throwIfAborted()
      try {
        if (!port) throw new Error('Waiting for container backend readiness')
        await inside([
          `${directory}/node`,
          '--input-type=commonjs',
          '-e',
          'const s=require("node:net").connect(Number(process.argv[1]),"127.0.0.1",()=>s.end());s.on("error",()=>process.exit(1));s.setTimeout(1000,()=>process.exit(1));',
          String(port),
        ])
        break
      } catch {
        signal.throwIfAborted()
        if (backend.exitCode !== null || Date.now() >= deadline)
          throw new Error(
            `Container editor backend failed to start: ${failure}`,
          )
        await delay(100, undefined, { signal })
      }
    }
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject)
      proxy.listen(0, '127.0.0.1', resolve)
    })
    signal.throwIfAborted()
    backend.once('exit', abort)
    const address = proxy.address()
    if (!address || typeof address === 'string')
      throw new Error('Container proxy did not start')
    return {
      close,
      port: address.port,
      token,
      workspacePath: state.remoteWorkspaceFolder,
      terminal: async (cwd: string) => {
        const relative = posix.relative(
          state.remoteWorkspaceFolder,
          cwd || state.remoteWorkspaceFolder,
        )
        if (relative === '..' || relative.startsWith('../'))
          throw new Error('Terminal path is outside the container workspace')
        const uri =
          result.workspaceUri +
          (relative
            ? '/' + relative.split('/').map(encodeURIComponent).join('/')
            : '')
        const options = await commandMap[
          'DevContainer.getTerminalSpawnOptions'
        ](result.workspaceUri, uri)
        return {
          ...options,
          dispose: async () => {
            const token = options.disposeCommand?.args?.[0]
            if (token) await commandMap['DevContainer.disposeTerminal'](token)
          },
        }
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

export const getInstallationDirectory = (): string => dirname(process.argv[1])
