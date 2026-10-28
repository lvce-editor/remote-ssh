import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

interface Setup {
  id: string
  secret: string
  backendUrl: string
}
export const validateBackendUrl = (value: string): string => {
  const url = new URL(value)
  if (
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Backend URL must be an HTTPS origin')
  return url.origin
}
class CloudflareRequestError extends Error {
  readonly status: number
  constructor(status: number) {
    super(
      `Cloudflare setup failed (HTTP ${status}). Check your LVCE tunnel claim and backend configuration; retry with a new approval if it expired.`,
    )
    this.status = status
  }
}
const request = async <T>(
  setup: Pick<Setup, 'backendUrl'> & { secret?: string },
  pathname: string,
  body: unknown = {},
  signal?: AbortSignal,
): Promise<T> => {
  const response = await fetch(new URL(pathname, setup.backendUrl), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.any([
      AbortSignal.timeout(15_000),
      ...(signal ? [signal] : []),
    ]),
    headers: {
      'Content-Type': 'application/json',
      ...(setup.secret ? { Authorization: `Bearer ${setup.secret}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new CloudflareRequestError(response.status)
  return (await response.json()) as T
}
const disableSetup = async (
  state: Setup,
  signal?: AbortSignal,
): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try {
      await request(
        state,
        `/cloudflare/requests/${state.id}/disable`,
        {},
        signal,
      )
      break
    } catch (error) {
      if (
        attempt >= 20 ||
        !(error instanceof CloudflareRequestError) ||
        error.status !== 409
      )
        throw error
      await delay(500, undefined, { signal })
    }
  }
}
export const disable = async (statePath: string): Promise<void> => {
  let contents: string
  try {
    contents = await readFile(statePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const state = JSON.parse(contents) as Setup
  validateBackendUrl(state.backendUrl)
  if (
    !/^[a-f0-9]{32}$/.test(state.id) ||
    !/^[A-Za-z0-9_-]{43}$/.test(state.secret)
  )
    throw new Error('Invalid saved Cloudflare setup')
  await disableSetup(state)
  await rm(statePath, { force: true })
  try {
    const owner = Number(await readFile(`${statePath}.lock/owner`, 'utf8'))
    if (!Number.isSafeInteger(owner) || owner <= 0) return
    try {
      process.kill(owner, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      await rm(`${statePath}.token`, { force: true })
      await rm(`${statePath}.lock`, { recursive: true, force: true })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
export interface Tunnel {
  readonly accountAccess: {
    readonly key: string
    readonly check: () => Promise<void>
  }
  readonly persistent: boolean
  readonly publicUrl: string
  readonly closed: Promise<void>
  readonly close: () => Promise<void>
}
export const enable = async (options: {
  readonly backendUrl: string
  readonly port: number
  readonly statePath: string
  readonly cloudflaredPath: string
  readonly signal: AbortSignal
  readonly output: (message: string) => void
}): Promise<Tunnel> => {
  const backendUrl = validateBackendUrl(options.backendUrl)
  if (
    !Number.isSafeInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  )
    throw new Error(
      'Cloudflare tunnel requires a fixed gateway port between 1 and 65535',
    )
  const directory = path.dirname(options.statePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lock = `${options.statePath}.lock`
  try {
    await mkdir(lock, { mode: 0o700 })
    await writeFile(path.join(lock, 'owner'), String(process.pid), {
      mode: 0o600,
      flag: 'wx',
    })
  } catch {
    throw new Error('Cloudflare setup is already running for this gateway port')
  }
  let child: ChildProcess | undefined
  const tokenPath = `${options.statePath}.token`
  const closed = Promise.withResolvers<void>()
  let finished = false
  const stop = async (): Promise<void> => {
    if (finished) return
    finished = true
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const timer = setTimeout(() => child?.kill('SIGKILL'), 5000)
      try {
        await closed.promise
      } finally {
        clearTimeout(timer)
      }
    }
    await rm(tokenPath, { force: true })
    await rm(lock, { recursive: true, force: true })
  }
  try {
    const enroll = async (): Promise<Setup> => {
      const credential = randomBytes(32).toString('base64url')
      const setup = await request<{
        id: string
        code: string
        verificationUrl: string
      }>(
        { backendUrl },
        '/cloudflare/requests',
        {
          port: options.port,
          secretHash: createHash('sha256').update(credential).digest('hex'),
        },
        options.signal,
      )
      if (!/^[a-f0-9]{32}$/.test(setup.id) || !/^[A-F0-9]{8}$/.test(setup.code))
        throw new Error('Invalid Cloudflare enrollment response')
      const verification = new URL(setup.verificationUrl)
      if (
        verification.origin !== backendUrl ||
        verification.pathname !== `/cloudflare/setup/${setup.id}` ||
        verification.search ||
        verification.hash
      )
        throw new Error('Invalid Cloudflare approval URL')
      const state = { backendUrl, id: setup.id, secret: credential }
      await writeFile(`${options.statePath}.tmp`, JSON.stringify(state), {
        mode: 0o600,
        flag: 'wx',
      })
      await rename(`${options.statePath}.tmp`, options.statePath)
      options.output(
        `Open ${verification.href}, claim tunnel access if needed, and confirm code ${setup.code}. Only approve this machine if the codes match.\n`,
      )
      return state
    }
    let state: Setup
    try {
      state = JSON.parse(await readFile(options.statePath, 'utf8')) as Setup
      if (
        validateBackendUrl(state.backendUrl) !== backendUrl ||
        !/^[a-f0-9]{32}$/.test(state.id) ||
        !/^[A-Za-z0-9_-]{43}$/.test(state.secret)
      )
        throw new Error(
          'Invalid saved Cloudflare setup or changed backend; disable the previous tunnel first',
        )
      options.output(
        'Reconnecting the saved tunnel. To enroll another machine, disable this tunnel first.\n',
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state = await enroll()
    }
    let deadline = Date.now() + 600_000
    let recovered = false
    let tunnel:
      | {
          status: string
          hostname?: string
          tunnelToken?: string
          persistent?: boolean
        }
      | undefined
    while (Date.now() < deadline) {
      options.signal.throwIfAborted()
      try {
        tunnel = await request(
          state,
          `/cloudflare/requests/${state.id}/poll`,
          {},
          options.signal,
        )
      } catch (error) {
        if (
          !(error instanceof CloudflareRequestError) ||
          error.status !== 410 ||
          recovered
        )
          throw error
        // Confirm provider cleanup before replacing the only saved management credential.
        await disableSetup(state, options.signal)
        options.signal.throwIfAborted()
        options.output(
          'The saved approval expired or its tunnel was disabled. Starting a new approval.\n',
        )
        state = await enroll()
        recovered = true
        deadline = Date.now() + 600_000
        continue
      }
      if (tunnel?.status === 'ready') break
      await delay(5000, undefined, { signal: options.signal })
    }
    if (
      tunnel?.status !== 'ready' ||
      typeof tunnel.hostname !== 'string' ||
      !/^[a-z0-9.-]+$/.test(tunnel.hostname) ||
      !tunnel.hostname.includes('.') ||
      typeof tunnel.tunnelToken !== 'string' ||
      !/^[A-Za-z0-9_+/=-]+$/.test(tunnel.tunnelToken)
    )
      throw new Error(
        'Cloudflare approval expired or returned invalid tunnel settings',
      )
    const browserKey = randomBytes(32).toString('hex')
    await request(
      state,
      `/cloudflare/requests/${state.id}/browser-access/register`,
      { key: browserKey },
      options.signal,
    )
    const accountAccess = {
      key: browserKey,
      check: async (): Promise<void> => {
        await request(
          state,
          `/cloudflare/requests/${state.id}/browser-access/check`,
          { key: browserKey },
          options.signal,
        )
      },
    }
    // A dead process can leave an old token file; this process owns the setup lock.
    await rm(tokenPath, { force: true })
    await writeFile(tokenPath, tunnel.tunnelToken, { mode: 0o600, flag: 'wx' })
    options.signal.throwIfAborted()
    child = spawn(
      options.cloudflaredPath,
      ['tunnel', '--no-autoupdate', 'run', '--token-file', tokenPath],
      { stdio: 'ignore' },
    )
    child.once('exit', () => closed.resolve())
    child.once('error', () => closed.resolve())
    await new Promise<void>((resolve, reject) => {
      child!.once('spawn', resolve)
      child!.once('error', () =>
        reject(
          new Error(
            'Could not start cloudflared. Install it on the remote machine or set --cloudflared-path=/absolute/path.',
          ),
        ),
      )
    })
    return {
      accountAccess,
      persistent: tunnel.persistent === true,
      publicUrl: `https://${tunnel.hostname}`,
      closed: closed.promise,
      close: stop,
    }
  } catch (error) {
    await stop()
    await rm(`${options.statePath}.tmp`, { force: true })
    // Retain the private management credential so disable can clean up after partial provisioning.
    throw error
  }
}
