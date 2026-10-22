import { NodeRpcProcess } from '@lvce-editor/rpc'
import { createRequire } from 'node:module'
const ts = createRequire(import.meta.url)(__LVCE_REMOTE_TYPESCRIPT_MODULE__)

await NodeRpcProcess.create({
  commandMap: {
    'Language.validate': async (uri) => {
      const fileName = decodeURIComponent(new URL(uri).pathname)
      const program = ts.createProgram([fileName], {
        noEmit: true,
        strict: true,
        skipLibCheck: true,
      })
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .filter((item) => item.file?.fileName === fileName)
        .map((item) => {
          const position = item.file.getLineAndCharacterOfPosition(
            item.start || 0,
          )
          return {
            code: item.code,
            columnIndex: position.character,
            endColumnIndex: position.character + (item.length || 1),
            endRowIndex: position.line,
            message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
            rowIndex: position.line,
            source: 'Remote TypeScript',
            type: 'error',
          }
        })
      return { diagnostics, pid: process.pid }
    },
  },
})
