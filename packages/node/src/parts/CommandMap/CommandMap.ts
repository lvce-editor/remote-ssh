import * as SshConfigHosts from '../SshConfigHosts/SshConfigHosts.ts'
import * as SshFileSystem from '../SshFileSystem/SshFileSystem.ts'

export const commandMap = {
  'SshConfigHosts.get': SshConfigHosts.getSshConfigHosts,
  'SshFileSystem.connect': SshFileSystem.connect,
  'SshFileSystem.mkdir': SshFileSystem.mkdir,
  'SshFileSystem.readDirWithFileTypes': SshFileSystem.readDirWithFileTypes,
  'SshFileSystem.readFile': SshFileSystem.readFile,
  'SshFileSystem.remove': SshFileSystem.remove,
  'SshFileSystem.rename': SshFileSystem.rename,
  'SshFileSystem.waitForOpenRequest': SshFileSystem.waitForOpenRequest,
  'SshFileSystem.writeFile': SshFileSystem.writeFile,
}
