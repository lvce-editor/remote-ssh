import { NodeRpcProcess } from '@lvce-editor/rpc'
import { readFile } from 'node:fs/promises'
await NodeRpcProcess.create({
  commandMap: {
    'Container.probe': async (workspace) => ({
      marker: await readFile('/container-marker', 'utf8'),
      cwd: process.cwd(),
      workspace,
    }),
  },
})
