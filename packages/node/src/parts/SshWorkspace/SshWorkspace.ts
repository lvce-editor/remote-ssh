import * as RemoteSshUri from '../RemoteSshUri/RemoteSshUri.ts'
import {
  invokeWorkspaceBackend,
  forwardPort as forwardSshPort,
  getForwardedPorts as getSshForwardedPorts,
  stopForwardPort as stopSshForwardPort,
  type InvokeBackend,
} from '../SshTransport/SshTransport.ts'

export const request = async (
  uri: string,
  type: string,
  args: readonly string[] = [],
  invoke: InvokeBackend = invokeWorkspaceBackend,
): Promise<unknown> => {
  const location = RemoteSshUri.parse(uri)
  switch (type) {
    case 'file-search': {
      const result = await invoke(
        location,
        'search-process',
        'SearchFile.searchFile',
        {
          limit: 100_000,
          ripGrepArgs: ['--files', '--hidden', '--glob', '!.git', '--'],
          searchPath: location.path,
        },
      )
      if (typeof result !== 'string') {
        throw new TypeError('Remote file search returned invalid results')
      }
      return result.split(/\r?\n/).filter(Boolean)
    }
    case 'git-remote':
      return invoke(
        location,
        'shared-process',
        'Workspace.getGitRemote',
        location.path,
      )
    case 'terminal-options':
      return invoke(
        location,
        'shared-process',
        'GetTerminalSpawnOptions.getTerminalSpawnOptions',
      )
    case 'text-search':
      return invoke(location, 'search-process', 'TextSearch.search', {
        ripGrepArgs: args,
        searchDir: location.path,
      })
    default:
      throw new Error(`Unsupported remote workspace request: ${type}`)
  }
}

export const forwardPort = async (
  uri: string,
  port: number,
): Promise<unknown> => {
  return forwardSshPort(RemoteSshUri.parse(uri), port)
}

export const stopForwardPort = async (
  uri: string,
  port: number,
): Promise<void> => {
  await stopSshForwardPort(RemoteSshUri.parse(uri), port)
}

export const getForwardedPorts = async (
  uri: string,
): Promise<readonly unknown[]> => {
  return getSshForwardedPorts(RemoteSshUri.parse(uri))
}
