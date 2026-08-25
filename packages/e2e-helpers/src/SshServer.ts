import type { Readable } from 'node:stream'
import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
} from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { delimiter, join } from 'node:path'

const host = '127.0.0.1'
const timeout = 120_000
const initialContent = 'before'
const remoteTerminalMarker = 'remote-ssh-pty-host'
const updatedContent = 'before after'

interface ProcessResult {
  readonly exitCode: number | null
  readonly stderr: string
  readonly stdout: string
}

interface SshdConfig {
  readonly authorizedKeysPath: string
  readonly hostKeyPath: string
  readonly pidPath: string
  readonly port: number
  readonly user: string
}

interface SshFixture {
  readonly initialContent: string
  readonly remoteTerminalMarker: string
  readonly target: string
  readonly updatedContent: string
  readonly workspacePath: string
}

interface SshServer {
  readonly dispose: () => Promise<void>
  readonly env: NodeJS.ProcessEnv
  readonly filePath: string
  readonly fixture: SshFixture
  readonly getConnectionCount: () => number
  readonly getOutput: () => string
}

type SshProcess = ChildProcessByStdio<null, Readable, Readable>

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

const findExecutable = async (name: string): Promise<string> => {
  const candidates = (process.env.PATH || '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, name))
  if (name === 'sshd') {
    candidates.push('/usr/sbin/sshd')
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue looking for the executable.
    }
  }
  throw new Error(`Required OpenSSH executable was not found: ${name}`)
}

const runProcess = async (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProcessResult> => {
  const child = spawn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout.on('data', (chunk: Buffer) => {
    stdout.push(String(chunk))
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr.push(String(chunk))
  })
  const { promise, reject, resolve } = Promise.withResolvers<ProcessResult>()
  child.once('error', reject)
  child.once('close', (exitCode) => {
    resolve({
      exitCode,
      stderr: stderr.join(''),
      stdout: stdout.join(''),
    })
  })
  return promise
}

const runProcessChecked = async (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProcessResult> => {
  const result = await runProcess(command, args, env)
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with code ${result.exitCode}\n${result.stderr || result.stdout}`,
    )
  }
  return result
}

const getAvailablePort = async (): Promise<number> => {
  const server = createServer()
  const { promise, reject, resolve } = Promise.withResolvers<number>()
  server.once('error', reject)
  server.listen(0, host, () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      reject(new Error('Failed to determine an available SSH port'))
      return
    }
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve(address.port)
    })
  })
  return promise
}

const isPortOpen = async (port: number): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const socket = createConnection({ host, port })
  const finish = (value: boolean): void => {
    socket.removeAllListeners()
    socket.destroy()
    resolve(value)
  }
  socket.once('connect', () => finish(true))
  socket.once('error', () => finish(false))
  socket.setTimeout(500, () => finish(false))
  return promise
}

const waitForPort = async (
  child: ChildProcess,
  port: number,
  output: readonly string[],
): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await isPortOpen(port)) {
      return
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `SSH server exited before accepting connections\n${output.join('')}`,
      )
    }
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for SSH server on ${host}:${port}\n${output.join('')}`,
  )
}

const waitForPath = async (
  path: string,
  child: ChildProcess,
  output: readonly string[],
): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < 10_000) {
    try {
      await access(path)
      return
    } catch {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `SSH agent exited before creating its socket\n${output.join('')}`,
        )
      }
      await sleep(50)
    }
  }
  throw new Error(`Timed out waiting for SSH agent socket: ${path}`)
}

const stopProcess = async (child: ChildProcess | undefined): Promise<void> => {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }
  try {
    if (child.pid === undefined) {
      child.kill('SIGTERM')
    } else {
      process.kill(-child.pid, 'SIGTERM')
    }
  } catch {
    child.kill('SIGTERM')
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    sleep(5000),
  ])
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (child.pid === undefined) {
        child.kill('SIGKILL')
      } else {
        process.kill(-child.pid, 'SIGKILL')
      }
    } catch {
      child.kill('SIGKILL')
    }
  }
}

const generateKey = async (
  sshKeygenPath: string,
  path: string,
): Promise<void> => {
  await runProcessChecked(sshKeygenPath, [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-f',
    path,
  ])
}

const buildSshdConfig = ({
  authorizedKeysPath,
  hostKeyPath,
  pidPath,
  port,
  user,
}: SshdConfig): string => {
  return [
    `Port ${port}`,
    `ListenAddress ${host}`,
    `HostKey ${hostKeyPath}`,
    `PidFile ${pidPath}`,
    `AuthorizedKeysFile ${authorizedKeysPath}`,
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'ChallengeResponseAuthentication no',
    'PubkeyAuthentication yes',
    'PermitRootLogin no',
    'UsePAM no',
    'PrintMotd no',
    `SetEnv LVCE_REMOTE_SSH_E2E_MARKER=${remoteTerminalMarker}`,
    'LogLevel VERBOSE',
    'StrictModes no',
    `AllowUsers ${user}`,
    '',
  ].join('\n')
}

const appendOutput = (output: string[], chunk: Buffer): void => {
  output.push(String(chunk))
  if (output.length > 200) {
    output.splice(0, output.length - 200)
  }
}

export const createSshServer = async (): Promise<SshServer | undefined> => {
  if (process.platform !== 'linux') {
    return undefined
  }

  const [sshPath, sshAddPath, sshAgentPath, sshKeygenPath, sshdPath] =
    await Promise.all([
      findExecutable('ssh'),
      findExecutable('ssh-add'),
      findExecutable('ssh-agent'),
      findExecutable('ssh-keygen'),
      findExecutable('sshd'),
    ])
  const root = await mkdtemp(join(tmpdir(), 'lvce-remote-ssh-e2e-'))
  const workspacePath = join(root, 'workspace')
  const filePath = join(workspacePath, 'file.txt')
  const folderPath = join(workspacePath, 'folder')
  const nestedFilePath = join(folderPath, 'nested.txt')
  const searchFilePath = join(workspacePath, 'search.txt')
  const clientKeyPath = join(root, 'id_ed25519')
  const hostKeyPath = join(root, 'ssh_host_ed25519_key')
  const authorizedKeysPath = join(root, 'authorized_keys')
  const pidPath = join(root, 'sshd.pid')
  const configPath = join(root, 'sshd_config')
  const agentSocketPath = join(root, 'agent.sock')
  const knownHostsPath = join(userInfo().homedir, '.ssh', 'known_hosts')
  const output: string[] = []
  let agent: SshProcess | undefined
  let server: SshProcess | undefined
  let port: number | undefined

  try {
    await mkdir(workspacePath)
    await mkdir(folderPath)
    await writeFile(filePath, initialContent)
    await writeFile(nestedFilePath, 'nested')
    await writeFile(searchFilePath, 'REMOTE_SEARCH_SENTINEL\n')
    await writeFile(join(workspacePath, '.gitignore'), 'ignored.txt\n')
    await writeFile(
      join(workspacePath, 'ignored.txt'),
      'REMOTE_SEARCH_SENTINEL\n',
    )
    await runProcessChecked('git', [
      '-C',
      workspacePath,
      'init',
      '--initial-branch',
      'main',
    ])
    await runProcessChecked('git', [
      '-C',
      workspacePath,
      'config',
      'user.name',
      'Remote SSH Test',
    ])
    await runProcessChecked('git', [
      '-C',
      workspacePath,
      'config',
      'user.email',
      'remote-ssh@example.com',
    ])
    await runProcessChecked('git', ['-C', workspacePath, 'add', '.'])
    await runProcessChecked('git', [
      '-C',
      workspacePath,
      'commit',
      '-m',
      'Initial commit',
    ])
    await generateKey(sshKeygenPath, hostKeyPath)
    await generateKey(sshKeygenPath, clientKeyPath)
    await writeFile(
      authorizedKeysPath,
      await readFile(`${clientKeyPath}.pub`, 'utf8'),
    )
    port = await getAvailablePort()
    const user = userInfo().username
    await writeFile(
      configPath,
      buildSshdConfig({
        authorizedKeysPath,
        hostKeyPath,
        pidPath,
        port,
        user,
      }),
    )

    agent = spawn(sshAgentPath, ['-D', '-a', agentSocketPath], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    agent.stdout.on('data', (chunk: Buffer) => appendOutput(output, chunk))
    agent.stderr.on('data', (chunk: Buffer) => appendOutput(output, chunk))
    await waitForPath(agentSocketPath, agent, output)
    const env = { ...process.env, SSH_AUTH_SOCK: agentSocketPath }
    await runProcessChecked(sshAddPath, [clientKeyPath], env)

    server = spawn(sshdPath, ['-D', '-f', configPath, '-e'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk: Buffer) => appendOutput(output, chunk))
    server.stderr.on('data', (chunk: Buffer) => appendOutput(output, chunk))
    await waitForPort(server, port, output)
    await runProcessChecked(
      sshPath,
      [
        '-T',
        '-p',
        String(port),
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        `UserKnownHostsFile=${join(root, 'known_hosts')}`,
        `${user}@${host}`,
        'true',
      ],
      env,
    )

    return {
      async dispose(): Promise<void> {
        await stopProcess(server)
        await stopProcess(agent)
        if (port) {
          try {
            await runProcessChecked(sshKeygenPath, [
              '-R',
              `[${host}]:${port}`,
              '-f',
              knownHostsPath,
            ])
            await unlink(`${knownHostsPath}.old`)
          } catch {
            // The provider may have exited before accepting the host key.
          }
        }
        await rm(root, { force: true, recursive: true })
      },
      env,
      filePath,
      fixture: {
        initialContent,
        remoteTerminalMarker,
        target: `ssh -p ${port} ${user}@${host}:${workspacePath}`,
        updatedContent,
        workspacePath,
      },
      getConnectionCount(): number {
        return output.join('').match(/Accepted publickey/g)?.length || 0
      },
      getOutput(): string {
        return output.join('')
      },
    }
  } catch (error) {
    await stopProcess(server)
    await stopProcess(agent)
    await rm(root, { force: true, recursive: true })
    throw error
  }
}
