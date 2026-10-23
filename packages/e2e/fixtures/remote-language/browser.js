import {
  activate,
  createNodeRpc,
  registerCommand,
  registerDiagnosticProvider,
  showNotification,
} from '@lvce-editor/api'

await activate()
let rpc
const validate = async (uri) => {
  rpc ||= createNodeRpc({ id: 'e2e.remote-language.compiler' })
  return (await rpc).invoke('Language.validate', uri)
}
registerDiagnosticProvider({
  id: 'e2e.remote-language',
  languageId: 'typescript',
  async provideDiagnostics(document) {
    return (await validate(document.uri)).diagnostics
  },
})
registerCommand({
  id: 'e2e.remote-language.validate',
  async execute() {
    const result = await validate(__LVCE_REMOTE_LANGUAGE_FILE__)
    await showNotification(
      'info',
      `Remote TypeScript (pid ${result.pid}): ${result.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ')}`,
    )
  },
})
