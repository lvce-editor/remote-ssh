const suffix = '.lvce-container.invalid'

/** A logical authority separates host/container resources without changing file paths. */
export const getContainer = (uri: string): string => {
  const { hostname } = new URL(uri)
  if (!hostname.endsWith(suffix)) return ''
  const id = hostname.slice(0, -suffix.length)
  if (!/^[a-f0-9]{32}$/.test(id))
    throw new Error('Invalid container workspace identity')
  return id
}

export const getPath = (uri: string): string => {
  getContainer(uri)
  return decodeURIComponent(new URL(uri).pathname)
}

export const create = (hostUri: string, id: string, path: string): string => {
  if (!/^[a-f0-9]{32}$/.test(id) || !path.startsWith('/'))
    throw new Error('Invalid container workspace')
  const url = new URL(hostUri)
  url.host = `${id}${suffix}`
  url.port = ''
  url.pathname = path.split('/').map(encodeURIComponent).join('/')
  return url.href
}
