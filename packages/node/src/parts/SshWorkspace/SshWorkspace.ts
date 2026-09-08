import * as RemoteSshUri from '../RemoteSshUri/RemoteSshUri.ts'
import {
  invokeWorkspaceBackend,
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
