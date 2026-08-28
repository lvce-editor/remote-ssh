import type { FileSystemDirent, FileSystemProvider } from '@lvce-editor/api'
import * as Rpc from '../Rpc/Rpc.ts'

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
  readonly writeFile: (uri: string, content: string) => Promise<void>
}

const decodeBase64 = (value: string): ArrayBuffer => {
  const bytes = Uint8Array.from(
    atob(value),
    (character) => character.codePointAt(0) || 0,
  )
  return bytes.buffer as ArrayBuffer
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
    pathSeparator: '/',
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
      return new Blob([decodeBase64(value)])
    },
    remove: async (uri): Promise<void> => {
      await invoke('SshFileSystem.remove', uri)
    },
    rename: async (oldUri, newUri): Promise<void> => {
      await invoke('SshFileSystem.rename', oldUri, newUri)
    },
    writeFile: async (uri, content): Promise<void> => {
      await invoke('SshFileSystem.writeFile', uri, content)
    },
  }
}

export const fileSystem = createRemoteFileSystem()
