import type { ConnectionOptions } from '../RemoteServerConnection/RemoteServerConnection.ts'

export interface Storage {
  readonly deleteSecret: (key: string) => Promise<void>
  readonly getAccountId?: () => Promise<string>
  readonly getSecret: (key: string) => Promise<string | undefined>
  readonly storeSecret: (key: string, value: string) => Promise<void>
}
const key = 'remote-server.session.v1'
const state: { storage: Storage | undefined; pending: Promise<unknown> } = {
  pending: Promise.resolve(),
  storage: undefined,
}

export const configure = (value: Storage | undefined): void => {
  state.storage = value
}
const run = async <T>(
  previous: Promise<unknown>,
  operation: () => Promise<T>,
): Promise<T> => {
  await previous
  return operation()
}
const ignoreFailure = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise
  } catch {
    /* Keep the next storage operation usable. */
  }
}
const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = run(state.pending, operation)
  state.pending = ignoreFailure(result)
  return result
}
export const save = (options: ConnectionOptions): Promise<void> => {
  const target = state.storage
  return serialize(async () => {
    await target?.storeSecret(key, JSON.stringify(options))
  })
}
export const clear = (): Promise<void> => {
  const target = state.storage
  return serialize(async () => {
    await target?.deleteSecret(key)
  })
}
const isValid = (value: unknown): value is ConnectionOptions => {
  if (!value || typeof value !== 'object') return false
  const options = value as Partial<ConnectionOptions>
  if (
    typeof options.sessionToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(options.sessionToken) ||
    (!options.account &&
      (typeof options.expiresAt !== 'number' ||
        !Number.isFinite(options.expiresAt) ||
        options.expiresAt <= Date.now())) ||
    (options.account &&
      options.expiresAt !== undefined &&
      (!Number.isFinite(options.expiresAt) ||
        options.expiresAt <= Date.now())) ||
    typeof options.websocketUrl !== 'string' ||
    typeof options.workspaceUri !== 'string'
  )
    return false
  try {
    const endpoint = new URL(options.websocketUrl)
    const workspace = new URL(options.workspaceUri)
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(
      endpoint.hostname,
    )
    return (
      (endpoint.protocol === 'wss:' ||
        (endpoint.protocol === 'ws:' && loopback)) &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash &&
      workspace.protocol === 'remote-server:' &&
      workspace.host === endpoint.host &&
      !workspace.username &&
      !workspace.password &&
      !workspace.search &&
      !workspace.hash
    )
  } catch {
    return false
  }
}
export const load = (): Promise<ConnectionOptions | undefined> => {
  const target = state.storage
  return serialize(async () => {
    const raw = await target?.getSecret(key)
    if (!raw) return undefined
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      value = undefined
    }
    if (isValid(value)) {
      if (!value.account) return value
      if (
        value.accountId &&
        value.accountId === (await target?.getAccountId?.())
      )
        return value
    }
    await target?.deleteSecret(key)
    return undefined
  })
}
