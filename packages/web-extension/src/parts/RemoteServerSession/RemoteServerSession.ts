import type { ConnectionOptions } from '../RemoteServerConnection/RemoteServerConnection.ts'

export interface Storage {
  readonly getSecret: (key: string) => Promise<string | undefined>
  readonly storeSecret: (key: string, value: string) => Promise<void>
  readonly deleteSecret: (key: string) => Promise<void>
}
const key = 'remote-server.session.v1'
let storage: Storage | undefined
let pending: Promise<unknown> = Promise.resolve()

export const configure = (value: Storage | undefined): void => {
  storage = value
}
const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = pending.then(operation)
  pending = result.catch(() => {})
  return result
}
export const save = (options: ConnectionOptions): Promise<void> => {
  const target = storage
  return serialize(async () => {
    await target?.storeSecret(key, JSON.stringify(options))
  })
}
export const clear = (): Promise<void> => {
  const target = storage
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
    typeof options.expiresAt !== 'number' ||
    !Number.isFinite(options.expiresAt) ||
    options.expiresAt <= Date.now() ||
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
  const target = storage
  return serialize(async () => {
    const raw = await target?.getSecret(key)
    if (!raw) return undefined
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      value = undefined
    }
    if (isValid(value)) return value
    await target?.deleteSecret(key)
    return undefined
  })
}
