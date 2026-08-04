export interface RemoteLocation {
  readonly identity: string
  readonly path: string
  readonly port: string
  readonly target: string
}

export const parse = (uri: string): RemoteLocation => {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new Error(`Invalid Remote SSH URI: ${uri}`)
  }
  if (url.protocol !== 'remote-ssh:') {
    throw new Error(`Expected remote-ssh URI, received ${uri}`)
  }
  if (!url.hostname) {
    throw new Error(`Remote SSH URI has no host: ${uri}`)
  }
  if (url.password) {
    throw new Error('Passwords are not allowed in Remote SSH URIs')
  }
  if (url.search || url.hash) {
    throw new Error('Remote SSH URIs must not contain a query or fragment')
  }
  const username = decodeURIComponent(url.username)
  const { hostname } = url
  const target = username ? `${username}@${hostname}` : hostname
  const path = decodeURIComponent(url.pathname || '/')
  if (!path.startsWith('/') || path.includes('\0')) {
    throw new Error(`Invalid remote path: ${path}`)
  }
  return {
    identity: JSON.stringify([username, hostname, url.port]),
    path,
    port: url.port,
    target,
  }
}
