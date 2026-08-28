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
  readonly readFile: (uri: string) => Promise<string>
  readonly remove: (uri: string) => Promise<void>
  readonly rename: (oldUri: string, newUri: string) => Promise<void>
  readonly writeFile: (uri: string, content: string) => Promise<void>
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
    readFile: async (uri): Promise<string> => {
      return (await invoke('SshFileSystem.readFile', uri)) as string
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
