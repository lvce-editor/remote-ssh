import { rejects, strictEqual } from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'

const execute = promisify(execFile)
const entry = fileURLToPath(
  new URL(
    '../../../.tmp/remote-ssh-server/lvce-remote-ssh-server.mjs',
    import.meta.url,
  ),
)
const directory = await mkdtemp(join(tmpdir(), 'lvce-web-cli-'))
const origin = 'https://lvce-editor.github.io'
const environment = {
  ...process.env,
  LVCE_REMOTE_SSH_ROOT: join(directory, 'runtime'),
  LVCE_REMOTE_SSH_IDLE_TIMEOUT: '2000',
  XDG_CONFIG_HOME: join(directory, 'config'),
  XDG_DATA_HOME: join(directory, 'data'),
  XDG_CACHE_HOME: join(directory, 'cache'),
  XDG_STATE_HOME: join(directory, 'state'),
}
let child
let socket
try {
  await writeFile(
    join(directory, 'hello.txt'),
    'Bundled gateway and real backend\n',
  )
  child = spawn(
    process.execPath,
    [
      entry,
      'serve-web',
      '--port=0',
      '--public-url=https://remote.example.com',
      `--allowed-origin=${origin}`,
      `--workspace=${directory}`,
    ],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stderr.on('data', (data) => {
    output = (output + String(data)).slice(-65536)
  })
  const lines = createInterface({ input: child.stdout })
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Bundled gateway did not start: ${output}`)),
      30000,
    )
    lines.on('line', (line) => {
      try {
        const value = JSON.parse(line)
        if (value.type === 'remote-web-ready') {
          clearTimeout(timeout)
          resolve(value)
        }
      } catch {
        /* Ignore non-readiness output. */
      }
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', () => {
      clearTimeout(timeout)
      reject(new Error(`Bundled gateway exited: ${output}`))
    })
  })
  const port = new URL(ready.localUrl).port
  const pair = async (pairingUrl) => {
    const response = await fetch(`${ready.localUrl}/auth/pair`, {
      method: 'POST',
      headers: {
        origin,
        authorization: `Bearer ${new URL(pairingUrl).hash.slice('#token='.length)}`,
        'x-lvce-protocol': '1',
      },
    })
    strictEqual(response.status, 200)
    return response.json()
  }
  await pair(ready.pairingUrl)
  const rotated = await execute(
    process.execPath,
    [entry, 'pair-web', `--port=${port}`],
    { env: environment },
  )
  const session = await pair(JSON.parse(rotated.stdout).pairingUrl)
  const ticketResponse = await fetch(
    `${ready.localUrl}/auth/websocket-ticket?process=file-system-process`,
    {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${session.sessionToken}` },
    },
  )
  strictEqual(ticketResponse.status, 200)
  const { ticket } = await ticketResponse.json()
  socket = new WebSocket(
    `ws://127.0.0.1:${port}/websocket/file-system-process?ticket=${ticket}`,
    { origin },
  )
  socket.on('error', () => {})
  await once(socket, 'open')
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Bundled gateway filesystem request timed out')),
      10000,
    )
    socket.on('message', (data) => {
      const message = JSON.parse(String(data))
      if (message.id === 1) {
        clearTimeout(timeout)
        resolve(message)
      }
    })
  })
  socket.send(
    JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'FileSystem.readFile',
      params: [pathToFileURL(join(directory, 'hello.txt')).href, 'utf8'],
    }),
  )
  strictEqual((await response).result, 'Bundled gateway and real backend\n')
  for (const options of [
    ['--port=0', `--allowed-origin=${origin}/lvce-editor`],
    [`--port=${port}`, `--allowed-origin=${origin}`],
  ]) {
    await rejects(
      execute(
        process.execPath,
        [
          entry,
          'serve-web',
          ...options,
          '--public-url=https://remote.example.com',
          `--workspace=${directory}`,
        ],
        { env: environment, timeout: 5000 },
      ),
      (error) => error.code === 1 && !error.killed,
    )
  }
  const closed = once(socket, 'close')
  await execute(process.execPath, [entry, 'revoke-web', `--port=${port}`], {
    env: environment,
  })
  await closed
  console.log(
    'PASS packaged serve-web, pair-web, real remote filesystem RPC, and revoke-web',
  )
} finally {
  socket?.terminate()
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  const runtime = join(directory, 'runtime', 'run')
  for (let attempt = 0; attempt < 60; attempt++) {
    const states = (await readdir(runtime).catch(() => [])).filter((name) =>
      /^server-.*\.json$/.test(name),
    )
    if (!states.length) break
    if (attempt === 30) {
      for (const name of states) {
        const state = JSON.parse(await readFile(join(runtime, name), 'utf8'))
        try {
          process.kill(state.pid, 'SIGTERM')
        } catch {
          /* Already exited. */
        }
      }
    }
    if (attempt === 59)
      throw new Error('Packaged gateway daemon did not clean up')
    await delay(100)
  }
  await rm(directory, { recursive: true, force: true })
}
