import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { openContainer } from '../src/RemoteContainer.ts'

const execute = promisify(execFile)

void test(
  'real container backend executes filesystem RPC in the container and cleans up its own server',
  { timeout: 180_000 },
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'lvce-tunnel-container-'))
    const signal = new AbortController()
    let backend
    let containerId
    try {
      await mkdir(join(workspace, '.devcontainer'))
      await writeFile(
        join(workspace, '.devcontainer', 'devcontainer.json'),
        JSON.stringify({
          image: 'mcr.microsoft.com/devcontainers/base:ubuntu24.04',
          workspaceFolder: '/workspace',
          workspaceMount: `source=${workspace},target=/workspace,type=bind`,
          remoteUser: 'root',
          postCreateCommand: 'echo only-in-container > /container-marker',
        }),
      )
      backend = await openContainer(
        resolve('.tmp/remote-ssh-server'),
        workspace,
        signal.signal,
      )
      const { stdout } = await execute('docker', [
        'ps',
        '-q',
        '--filter',
        `label=devcontainer.local_folder=${workspace}`,
      ])
      containerId = stdout.trim()
      const socket = new WebSocket(
        `ws://127.0.0.1:${backend.port}/websocket/file-system-process?token=${backend.token}`,
      )
      socket.on('error', () => {})
      await once(socket, 'open')
      const response = new Promise((resolve, reject) => {
        socket.on('message', (data) => {
          const value = JSON.parse(String(data))
          if (value?.id === 1) {
            socket.close()
            value.error ? reject(value.error) : resolve(value.result)
          }
        })
      })
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'FileSystem.readFile',
          params: ['file:///container-marker', 'utf8'],
        }),
      )
      assert.equal(await response, 'only-in-container\n')
      assert.equal(backend.workspacePath, '/workspace')
      await backend.close()
      backend = undefined
      const alive = await execute('docker', [
        'exec',
        containerId,
        'sh',
        '-c',
        'test -f /container-marker && echo preserved',
      ])
      assert.equal(alive.stdout.trim(), 'preserved')
    } finally {
      await backend?.close()
      if (containerId) await execute('docker', ['rm', '-f', containerId])
      await rm(workspace, { force: true, recursive: true })
    }
  },
)
