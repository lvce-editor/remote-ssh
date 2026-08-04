import * as RemoteSshUri from '../RemoteSshUri/RemoteSshUri.ts'
import { runSsh, type RunSsh } from '../SshTransport/SshTransport.ts'

const invoke = async (
  operation: string,
  uri: string,
  extra: Readonly<Record<string, unknown>> = {},
  run: RunSsh = runSsh,
): Promise<unknown> => {
  const location = RemoteSshUri.parse(uri)
  return run(location, {
    operation,
    path: location.path,
    ...extra,
  })
}

export const connect = (uri: string): Promise<unknown> => {
  return invoke('connect', uri)
}

export const readDirWithFileTypes = (uri: string): Promise<unknown> => {
  return invoke('readDirWithFileTypes', uri)
}

export const readFile = async (uri: string): Promise<string> => {
  const result = await invoke('readFile', uri)
  if (typeof result !== 'string') {
    throw new TypeError('Remote SSH read returned invalid content')
  }
  return Buffer.from(result, 'base64').toString('utf8')
}

export const writeFile = (uri: string, content: string): Promise<unknown> => {
  return invoke('writeFile', uri, {
    content: Buffer.from(content).toString('base64'),
  })
}

export const mkdir = (uri: string): Promise<unknown> => {
  return invoke('mkdir', uri)
}

export const remove = (uri: string): Promise<unknown> => {
  return invoke('remove', uri)
}

export const rename = async (
  oldUri: string,
  newUri: string,
): Promise<unknown> => {
  const oldLocation = RemoteSshUri.parse(oldUri)
  const newLocation = RemoteSshUri.parse(newUri)
  if (oldLocation.identity !== newLocation.identity) {
    throw new Error('Cannot rename across SSH hosts')
  }
  return runSsh(oldLocation, {
    newPath: newLocation.path,
    operation: 'rename',
    path: oldLocation.path,
  })
}

export const _invoke = invoke
