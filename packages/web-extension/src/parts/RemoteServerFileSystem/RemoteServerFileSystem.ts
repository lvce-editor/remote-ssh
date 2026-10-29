import type { FileSystemDirent, FileSystemProvider } from '@lvce-editor/api'
import * as RemoteServerConnection from '../RemoteServerConnection/RemoteServerConnection.ts'

export type Invoke = (
  method: string,
  ...params: readonly unknown[]
) => Promise<unknown>

export interface RemoteServerFileSystem extends FileSystemProvider {
  readonly getDirectoryVersion: (uri: string) => Promise<string | null>
  readonly mkdir: (uri: string) => Promise<void>
  readonly readDirWithFileTypes: (
    uri: string,
  ) => Promise<readonly FileSystemDirent[]>
  readonly readFile: (uri: string) => Promise<string>
  readonly remove: (uri: string) => Promise<void>
  readonly rename: (oldUri: string, newUri: string) => Promise<void>
  readonly stat: (uri: string) => Promise<number>
  readonly writeFile: (uri: string, content: string) => Promise<void>
}

const getLocation = (
  uri: string,
): { readonly authority: string; readonly path: string } => {
  const url = new URL(uri)
  if (url.protocol !== 'remote-server:' || !url.host) {
    throw new TypeError(`Invalid remote server URI: ${uri}`)
  }
  return {
    authority: url.host,
    path: decodeURIComponent(url.pathname),
  }
}

const toFileUri = (filePath: string): string => {
  const url = new URL('file:///')
  url.pathname = filePath
  return url.href
}

const invokeFileSystem = async (
  invoke: Invoke,
  method: string,
  uri: string,
  ...params: readonly unknown[]
): Promise<unknown> => {
  const location = getLocation(uri)
  if (invoke === RemoteServerConnection.invoke) {
    if (!RemoteServerConnection.getOptions())
      await RemoteServerConnection.restore()
    RemoteServerConnection.assertWorkspace(uri)
  }
  return invoke(method, toFileUri(location.path), ...params)
}

const requireMutable = (uri: string): void => {
  if (getLocation(uri).path === '/') {
    throw new Error('Cannot modify the remote root folder')
  }
}

export const createRemoteServerFileSystem = (
  invoke: Invoke = RemoteServerConnection.invoke,
): RemoteServerFileSystem => {
  return {
    getDirectoryVersion: async (uri): Promise<string | null> => {
      const value = await invokeFileSystem(
        invoke,
        'FileSystem.getDirectoryVersion',
        uri,
      )
      return typeof value === 'string' && value.length > 0 ? value : null
    },
    id: 'remote-server',
    isReadonly: (): boolean => false,
    mkdir: async (uri): Promise<void> => {
      requireMutable(uri)
      await invokeFileSystem(invoke, 'FileSystem.mkdir', uri)
    },
    readDirWithFileTypes: async (uri): Promise<readonly FileSystemDirent[]> => {
      const value = await invokeFileSystem(
        invoke,
        'FileSystem.readDirWithFileTypes',
        uri,
      )
      if (!Array.isArray(value)) {
        throw new TypeError('Remote server returned invalid directory entries')
      }
      return value
        .map((entry) => (entry?.type === 9 ? { ...entry, type: 7 } : entry))
        .toSorted((a, b) => String(a?.name).localeCompare(String(b?.name)))
    },
    readFile: async (uri): Promise<string> => {
      const value = await invokeFileSystem(
        invoke,
        'FileSystem.readFile',
        uri,
        'utf8',
      )
      if (typeof value !== 'string') {
        throw new TypeError('Remote server returned invalid file content')
      }
      return value
    },
    remove: async (uri): Promise<void> => {
      requireMutable(uri)
      await invokeFileSystem(invoke, 'FileSystem.forceRemove', uri)
    },
    rename: async (oldUri, newUri): Promise<void> => {
      const oldLocation = getLocation(oldUri)
      const newLocation = getLocation(newUri)
      if (invoke === RemoteServerConnection.invoke) {
        if (!RemoteServerConnection.getOptions())
          await RemoteServerConnection.restore()
        RemoteServerConnection.assertWorkspace(oldUri)
        RemoteServerConnection.assertWorkspace(newUri)
      }
      if (oldLocation.authority !== newLocation.authority) {
        throw new Error('Cannot rename across remote servers')
      }
      requireMutable(oldUri)
      requireMutable(newUri)
      try {
        await invoke('FileSystem.stat', toFileUri(newLocation.path))
        const error = new Error('File exists') as Error & { code?: string }
        error.code = 'EEXIST'
        throw error
      } catch (error) {
        if ((error as Error & { code?: string }).code !== 'ENOENT') {
          throw error
        }
      }
      await invoke(
        'FileSystem.rename',
        toFileUri(oldLocation.path),
        toFileUri(newLocation.path),
      )
    },
    stat: async (uri): Promise<number> => {
      return (await invokeFileSystem(invoke, 'FileSystem.stat', uri)) as number
    },
    writeFile: async (uri, content): Promise<void> => {
      requireMutable(uri)
      await invokeFileSystem(
        invoke,
        'FileSystem.writeFile',
        uri,
        content,
        'utf8',
      )
    },
  }
}

export const fileSystem = createRemoteServerFileSystem()

export const _getLocation = getLocation
