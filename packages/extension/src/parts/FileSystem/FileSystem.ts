import type { FileSystemDirent, FileSystemProvider } from '@lvce-editor/api'
import * as Rpc from '../Rpc/Rpc.ts'

// cspell:ignore apng jfif

export type Invoke = (
  method: string,
  ...params: readonly unknown[]
) => Promise<unknown>

export interface RemoteFileSystem extends FileSystemProvider {
  readonly mkdir: (uri: string) => Promise<void>
  readonly readDirWithFileTypes: (
    uri: string,
  ) => Promise<readonly FileSystemDirent[]>
  readonly readFile: (uri: string) => Promise<Blob>
  readonly remove: (uri: string) => Promise<void>
  readonly rename: (oldUri: string, newUri: string) => Promise<void>
  readonly stat: (uri: string) => Promise<number>
  readonly writeFile: (uri: string, content: string) => Promise<void>
}

const decodeBase64 = (value: string): ArrayBuffer => {
  const bytes = Uint8Array.from(
    atob(value),
    (character) => character.codePointAt(0) || 0,
  )
  return bytes.buffer
}

const getMimeType = (uri: string): string => {
  const path = new URL(uri).pathname.toLowerCase()
  const extension = path.slice(path.lastIndexOf('.'))
  switch (extension) {
    case '.apng':
      return 'image/apng'
    case '.avif':
      return 'image/avif'
    case '.bmp':
      return 'image/bmp'
    case '.gif':
      return 'image/gif'
    case '.heic':
      return 'image/heic'
    case '.heif':
      return 'image/heif'
    case '.ico':
      return 'image/x-icon'
    case '.jfif':
    case '.jpe':
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.svg':
      return 'image/svg+xml'
    case '.tif':
    case '.tiff':
      return 'image/tiff'
    case '.webp':
      return 'image/webp'
    default:
      return ''
  }
}

export const createRemoteFileSystem = (
  invoke: Invoke = Rpc.invoke,
): RemoteFileSystem => {
  return {
    id: 'remote-ssh',
    isReadonly: () => false,
    mkdir: async (uri): Promise<void> => {
      await invoke('SshFileSystem.mkdir', uri)
    },
    readDirWithFileTypes: async (uri): Promise<readonly FileSystemDirent[]> => {
      return (await invoke(
        'SshFileSystem.readDirWithFileTypes',
        uri,
      )) as readonly FileSystemDirent[]
    },
    readFile: async (uri): Promise<Blob> => {
      const value = await invoke('SshFileSystem.readFile', uri)
      if (typeof value !== 'string') {
        throw new TypeError('Remote SSH read returned invalid content')
      }
      return new Blob([decodeBase64(value)], { type: getMimeType(uri) })
    },
    remove: async (uri): Promise<void> => {
      await invoke('SshFileSystem.remove', uri)
    },
    rename: async (oldUri, newUri): Promise<void> => {
      await invoke('SshFileSystem.rename', oldUri, newUri)
    },
    stat: async (uri): Promise<number> => {
      return (await invoke('SshFileSystem.stat', uri)) as number
    },
    writeFile: async (uri, content): Promise<void> => {
      await invoke('SshFileSystem.writeFile', uri, content)
    },
  }
}

export const fileSystem = createRemoteFileSystem()
