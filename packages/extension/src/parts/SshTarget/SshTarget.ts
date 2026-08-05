const sshCommand = 'ssh'

const assertPort = (port: string): void => {
  if (!/^\d+$/.test(port)) {
    throw new Error(`Invalid SSH port: ${port}`)
  }
  const value = Number(port)
  if (value < 1 || value > 65_535) {
    throw new Error(`Invalid SSH port: ${port}`)
  }
}

interface ParsedOptions {
  readonly port: string
  readonly user: string
}

const parseOptions = (tokens: readonly string[]): ParsedOptions => {
  let port = ''
  let user = ''
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === '--') {
      continue
    }
    if (token !== '-p' && token !== '-l') {
      throw new Error(`Unsupported SSH option or argument: ${token}`)
    }
    const argument = tokens[++index]
    if (!argument) {
      throw new Error(`Missing argument for ${token}`)
    }
    if (token === '-p') {
      assertPort(argument)
      port = argument
    } else {
      user = argument
    }
  }
  return { port, user }
}

const parseCommand = (value: string): { destination: string; port: string } => {
  const tokens = value.split(/\s+/)
  if (tokens[0] !== sshCommand) {
    return { destination: value, port: '' }
  }
  if (tokens.length < 2) {
    throw new Error('SSH host is required')
  }
  let destination = tokens.at(-1) || ''
  if (!destination || destination.startsWith('-')) {
    throw new Error('SSH host is required')
  }
  const { port, user } = parseOptions(tokens.slice(1, -1))
  if (user) {
    if (destination.includes('@')) {
      throw new Error('SSH user was specified more than once')
    }
    destination = `${user}@${destination}`
  }
  return { destination, port }
}

const splitRemotePath = (
  destination: string,
): { authority: string; path: string } => {
  const match = /^(.*):(\/.*)$/.exec(destination)
  if (!match) {
    return { authority: destination, path: '/' }
  }
  return { authority: match[1], path: match[2] }
}

const parseUrl = (value: string): URL => {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('SSH host is required')
  }
  if (trimmed.startsWith('ssh://')) {
    return new URL(trimmed)
  }
  const { destination, port } = parseCommand(trimmed)
  if (/\s/.test(destination)) {
    throw new Error('SSH host must not contain whitespace')
  }
  const { authority, path } = splitRemotePath(destination)
  const url = new URL(`ssh://${authority}${path}`)
  if (port) {
    if (url.port) {
      throw new Error('SSH port was specified more than once')
    }
    url.port = port
  }
  return url
}

export const toRemoteSshUri = (value: string): string => {
  const url = parseUrl(value)
  if (!url.hostname) {
    throw new Error('SSH host is required')
  }
  if (url.password) {
    throw new Error('Passwords are not allowed in Remote SSH URIs')
  }
  if (url.search || url.hash) {
    throw new Error('SSH host must not contain a query or fragment')
  }
  if (url.port) {
    assertPort(url.port)
  }
  const username = decodeURIComponent(url.username)
  if (username.startsWith('-') || url.hostname.startsWith('-')) {
    throw new Error('SSH target must not start with a hyphen')
  }
  url.protocol = 'remote-ssh:'
  return url.href
}
