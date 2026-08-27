import path from 'node:path'
import * as RemoteSshUri from '../RemoteSshUri/RemoteSshUri.ts'
import {
  connectWorkspaceBackend,
  invokeWorkspaceBackend,
  type InvokeBackend,
  type OpenRequest,
  type WorkspaceBackend,
  waitForOpenRequest as waitForTransportOpenRequest,
} from '../SshTransport/SshTransport.ts'

const toFileUri = (filePath: string): string => {
  const url = new URL('file:///')
  url.pathname = filePath
  return url.href
}

const invoke = (
  method: string,
  uri: string,
  params: readonly unknown[] = [],
  invokeBackend: InvokeBackend = invokeWorkspaceBackend,
): Promise<unknown> => {
  const location = RemoteSshUri.parse(uri)
  return invokeBackend(
    location,
    'file-system-process',
    method,
    toFileUri(location.path),
    ...params,
  )
}

const requireMutable = (filePath: string): void => {
  if (filePath === '/') {
    throw new Error('Cannot modify the remote root folder')
  }
}

const sortDirents = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) {
    throw new TypeError('Remote SSH directory read returned invalid entries')
  }
  return value
    .map((entry) => (entry?.type === 9 ? { ...entry, type: 7 } : entry))
    .toSorted((a, b) => String(a?.name).localeCompare(String(b?.name)))
}

export const connect = async (uri: string): Promise<WorkspaceBackend> => {
  const location = RemoteSshUri.parse(uri)
  const type = await invoke('FileSystem.stat', uri)
  if (type !== 3) {
    throw new Error(`Not a directory: ${location.path}`)
  }
  return {
    ...(await connectWorkspaceBackend(location)),
    workspacePath: location.path,
  }
}

export const waitForOpenRequest = async (
  uri: string,
  wait: (
    location: RemoteSshUri.RemoteLocation,
  ) => Promise<OpenRequest> = waitForTransportOpenRequest,
): Promise<{
  readonly kind: OpenRequest['kind']
  readonly uri: string
  readonly workspacePath: string
  readonly workspaceUri: string
}> => {
  const location = RemoteSshUri.parse(uri)
  const request = await wait(location)
  const url = new URL(uri)
  url.pathname = request.path
  const workspaceUrl = new URL(uri)
  workspaceUrl.pathname =
    request.kind === 'folder' ? request.path : path.posix.dirname(request.path)
  return {
    kind: request.kind,
    uri: url.href,
    workspacePath:
      request.kind === 'folder'
        ? request.path
        : path.posix.dirname(request.path),
    workspaceUri: workspaceUrl.href,
  }
}

export const readDirWithFileTypes = async (uri: string): Promise<unknown> => {
  const result = await invoke('FileSystem.readDirWithFileTypes', uri)
  return sortDirents(result)
}

export const readFile = async (uri: string): Promise<string> => {
  const result = await invoke('FileSystem.readFile', uri, ['base64'])
  if (typeof result !== 'string') {
    throw new TypeError('Remote SSH read returned invalid content')
  }
  return Buffer.from(result, 'base64').toString('utf8')
}

export const writeFile = (uri: string, content: string): Promise<unknown> => {
  const location = RemoteSshUri.parse(uri)
  requireMutable(location.path)
  return invoke('FileSystem.writeFile', uri, [
    Buffer.from(content).toString('base64'),
    'base64',
  ])
}

export const mkdir = (uri: string): Promise<unknown> => {
  const location = RemoteSshUri.parse(uri)
  requireMutable(location.path)
  return invoke('FileSystem.mkdir', uri)
}

export const remove = (uri: string): Promise<unknown> => {
  const location = RemoteSshUri.parse(uri)
  requireMutable(location.path)
  return invoke('FileSystem.forceRemove', uri)
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
  requireMutable(oldLocation.path)
  requireMutable(newLocation.path)
  try {
    await invokeWorkspaceBackend(
      newLocation,
      'file-system-process',
      'FileSystem.stat',
      toFileUri(newLocation.path),
    )
    const error = new Error(
      `File exists: ${newLocation.path}`,
    ) as NodeJS.ErrnoException
    error.code = 'EEXIST'
    throw error
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  return invokeWorkspaceBackend(
    oldLocation,
    'file-system-process',
    'FileSystem.rename',
    toFileUri(oldLocation.path),
    toFileUri(newLocation.path),
  )
}

export const _invoke = invoke
export const _sortDirents = sortDirents
export const _toFileUri = toFileUri
