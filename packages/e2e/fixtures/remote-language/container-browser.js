import { activate, createNodeRpc, registerCommand } from '@lvce-editor/api'
await activate()
let rpc
registerCommand({
  id: 'e2e.remote-language.probe',
  async execute(uri) {
    rpc ||= createNodeRpc({ id: 'e2e.remote-language.compiler' })
    return (await rpc).invoke('Container.probe', uri)
  },
})
