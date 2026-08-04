import { spawn } from 'node:child_process'
import type { RemoteLocation } from '../RemoteSshUri/RemoteSshUri.ts'
import * as RemoteHelper from '../RemoteHelper/RemoteHelper.ts'

export interface RemoteRequest {
  readonly content?: string
  readonly newPath?: string
  readonly operation: string
  readonly path: string
}

interface RemoteResponse {
  readonly code?: number | null
  readonly error?: string
  readonly ok: boolean
  readonly result?: unknown
}

export type RunSsh = (
  location: RemoteLocation,
  request: RemoteRequest,
) => Promise<unknown>

const sshExecutable =
  process.platform === 'win32'
    ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
    : '/usr/bin/ssh'

const getSshArgs = (location: RemoteLocation): readonly string[] => {
  const portArgs = location.port ? ['-p', location.port] : []
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=accept-new',
    ...portArgs,
    location.target,
    RemoteHelper.command,
  ]
}

const runProcess = (
  args: readonly string[],
  input: string,
): Promise<{ readonly stderr: string; readonly stdout: string }> => {
  return new Promise((resolve, reject) => {
    const child = spawn(sshExecutable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Remote SSH operation timed out after 120 seconds'))
    }, 120_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // When SSH exits before consuming the request, its exit status and
      // stderr contain the useful connection error.
      if (error.code === 'EPIPE') {
        return
      }
      clearTimeout(timeout)
      reject(error)
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(new Error(`Failed to start OpenSSH: ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      const standardOutput = Buffer.concat(stdout).toString('utf8')
      const standardError = Buffer.concat(stderr).toString('utf8').trim()
      if (code !== 0) {
        reject(
          new Error(
            standardError || `OpenSSH exited with status ${String(code)}`,
          ),
        )
        return
      }
      resolve({ stderr: standardError, stdout: standardOutput })
    })
    child.stdin.end(input)
  })
}

const parseResponse = (stdout: string): RemoteResponse => {
  const line = stdout
    .split(/\r?\n/)
    .findLast((candidate) => candidate.startsWith(RemoteHelper.marker))
  if (!line) {
    throw new Error('Remote helper returned no response')
  }
  try {
    return JSON.parse(line.slice(RemoteHelper.marker.length)) as RemoteResponse
  } catch {
    throw new Error('Remote helper returned an invalid response')
  }
}

export const runSsh: RunSsh = async (location, request) => {
  const args = getSshArgs(location)
  const { stdout } = await runProcess(args, JSON.stringify(request))
  const response = parseResponse(stdout)
  if (!response.ok) {
    const suffix = response.code == null ? '' : ` (errno ${response.code})`
    throw new Error(`${response.error || 'Remote operation failed'}${suffix}`)
  }
  return response.result
}

export const _getSshArgs = getSshArgs
export const _parseResponse = parseResponse
