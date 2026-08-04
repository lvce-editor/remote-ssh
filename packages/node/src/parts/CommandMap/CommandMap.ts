import * as SshFileSystem from '../SshFileSystem/SshFileSystem.ts'

export const commandMap = {
  'SshFileSystem.connect': SshFileSystem.connect,
  'SshFileSystem.mkdir': SshFileSystem.mkdir,
  'SshFileSystem.readDirWithFileTypes': SshFileSystem.readDirWithFileTypes,
  'SshFileSystem.readFile': SshFileSystem.readFile,
  'SshFileSystem.remove': SshFileSystem.remove,
  'SshFileSystem.rename': SshFileSystem.rename,
  'SshFileSystem.writeFile': SshFileSystem.writeFile,
}
