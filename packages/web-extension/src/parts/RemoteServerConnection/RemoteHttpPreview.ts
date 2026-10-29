import * as Connection from './RemoteServerConnection.ts'

const previewConnections = new WeakSet<Connection.ConnectionOptions>()

export const resolveHttpPreview = async (
  workspaceUri: string,
  uri: string,
): Promise<string> => {
  const target = new URL(uri)
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
    target.username ||
    target.password
  )
    throw new Error('Preview requires an HTTP loopback URL without credentials')
  if (!Connection.getOptions()) await Connection.restore()
  const options = Connection.getOptions()
  const workspace = new URL(workspaceUri)
  const root = options?.workspaceUri && new URL(options.workspaceUri)
  if (
    !options ||
    !root ||
    workspace.protocol !== root.protocol ||
    workspace.host !== root.host ||
    (workspace.pathname !== root.pathname &&
      !workspace.pathname.startsWith(root.pathname.replace(/\/$/, '') + '/'))
  )
    throw new Error('Preview workspace is not connected')
  const generation = Connection.getGeneration()
  const endpoint = new URL('/auth/http-preview', options.websocketUrl)
  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:'
  endpoint.searchParams.set(
    'port',
    target.port || (target.protocol === 'https:' ? '443' : '80'),
  )
  endpoint.searchParams.set('protocol', target.protocol)
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${options.sessionToken}` },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok)
    throw new Error(
      `Remote HTTP preview unavailable (HTTP ${response.status}). Update the remote server or reconnect and retry.`,
    )
  const result = (await response.json()) as { previewUrl?: unknown }
  if (typeof result.previewUrl !== 'string')
    throw new Error('Invalid remote preview response')
  const base = new URL(result.previewUrl)
  if (
    base.origin !== endpoint.origin ||
    !/^\/preview\/[a-f0-9]{64}\/$/.test(base.pathname) ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  )
    throw new Error('Invalid remote preview endpoint')
  if (
    Connection.getOptions() !== options ||
    Connection.getGeneration() !== generation
  )
    throw new Error('Workspace changed while opening preview')
  previewConnections.add(options)
  // Concatenation keeps a leading double slash in a target path inside this grant.
  return `${base.href.slice(0, -1)}${target.pathname}${target.search}${target.hash}`
}

export const revokePreviews = async (
  options: Connection.ConnectionOptions,
): Promise<void> => {
  if (!previewConnections.has(options)) return
  previewConnections.delete(options)
  const endpoint = new URL('/auth/revoke-previews', options.websocketUrl)
  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:'
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${options.sessionToken}` },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  // Older servers have no preview capabilities to revoke.
  if (!response.ok && response.status !== 401 && response.status !== 404)
    throw new Error('Could not revoke remote previews')
}
