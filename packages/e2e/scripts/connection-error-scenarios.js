import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

const unusedPort = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

export const runConnectionErrorScenarios = async (
  sshServer,
  remoteRoot,
  checkError,
) => {
  const target = sshServer.fixture.target
  const installFixture = async (source) => {
    const runtime = join(remoteRoot, 'runtimes', 'test-node', 'bin')
    const server = join(remoteRoot, 'servers', 'dev')
    await mkdir(runtime, { recursive: true })
    await mkdir(server, { recursive: true })
    await symlink(process.execPath, join(runtime, 'node'))
    await writeFile(join(server, 'lvce-remote-ssh-server.mjs'), source)
  }
  try {
    await checkError(
      target.replace(/-p \d+/, `-p ${await unusedPort()}`),
      'E_SSH_CONNECTION_REFUSED',
      'connection was refused',
    )
    await checkError(
      target.replace(/\s\S+@/, ' lvce-no-such-user@'),
      'E_SSH_AUTHENTICATION_FAILED',
      'rejected authentication',
    )

    await writeFile(
      remoteRoot,
      'This file prevents creating the remote server directory',
    )
    await checkError(
      target,
      'E_SSH_INSTALL_FAILED',
      'installing the LVCE remote server failed',
    )
    await rm(remoteRoot)

    await installFixture("throw new Error('SERVER_START_SENTINEL')")
    await checkError(
      target,
      'E_SSH_SERVER_START_FAILED',
      'SERVER_START_SENTINEL',
    )
    await rm(remoteRoot, { recursive: true })

    const ready = {
      arch: 'x64',
      backend: { port: await unusedPort(), token: 'test-backend-token' },
      capabilities: ['fileSystemProcess', 'remoteCli', 'workspaceBackend'],
      clientVersion: 'dev',
      platform: 'linux',
      protocolVersion: 1,
      type: 'ready',
      version: 'dev',
    }
    await installFixture(
      `console.log(${JSON.stringify(JSON.stringify(ready))}); process.stdin.resume(); process.stdin.on('end', () => process.exit(0))`,
    )
    await checkError(
      target,
      'E_SSH_BACKEND_FAILED',
      'remote workspace backend connection failed',
    )
  } finally {
    await rm(remoteRoot, { force: true, recursive: true })
  }
}
