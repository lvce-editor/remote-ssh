import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ReadConfig = (path: string, encoding: 'utf8') => Promise<string>

const normalizeToken = (token: string): string | undefined => {
  const first = token[0]
  const last = token.at(-1)
  if (first === '"' || first === "'") {
    return last === first ? token.slice(1, -1) : undefined
  }
  if (token.includes('"') || token.includes("'") || token.includes('\\')) {
    return undefined
  }
  return token
}

const parseTokens = (value: string): readonly string[] => {
  const commentIndex = value.indexOf('#')
  const uncommented = commentIndex === -1 ? value : value.slice(0, commentIndex)
  return uncommented
    .trim()
    .split(/\s+/)
    .map(normalizeToken)
    .filter((token): token is string => Boolean(token))
}

const getHostValue = (line: string): string | undefined => {
  const trimmed = line.trimStart()
  if (trimmed.slice(0, 4).toLowerCase() !== 'host') {
    return undefined
  }
  const separator = trimmed[4]
  if (separator !== '=' && !/\s/.test(separator || '')) {
    return undefined
  }
  const value = trimmed.slice(5).trimStart()
  return value.startsWith('=') ? value.slice(1).trimStart() : value
}

const isLiteralHost = (host: string): boolean => {
  return host.length > 0 && !/[\s!*?]/.test(host)
}

const addHosts = (
  candidates: readonly string[],
  hosts: string[],
  seen: Set<string>,
): void => {
  for (const host of candidates) {
    const key = host.toLowerCase()
    if (isLiteralHost(host) && !seen.has(key)) {
      hosts.push(host)
      seen.add(key)
    }
  }
}

export const parseSshConfigHosts = (content: string): readonly string[] => {
  const hosts: string[] = []
  const seen = new Set<string>()

  for (const line of content.split(/\r?\n/)) {
    const value = getHostValue(line)
    if (value !== undefined) {
      addHosts(parseTokens(value), hosts, seen)
    }
  }

  return hosts
}

export const getSshConfigHosts = async (
  readConfig: ReadConfig = readFile,
  homeDirectory: string = homedir(),
): Promise<readonly string[]> => {
  try {
    const content = await readConfig(
      join(homeDirectory, '.ssh', 'config'),
      'utf8',
    )
    return parseSshConfigHosts(content)
  } catch {
    return []
  }
}
