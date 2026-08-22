import { NodeRpcProcess } from '@lvce-editor/rpc'
import { commandMap } from './remoteSshClient.ts'

await NodeRpcProcess.create({ commandMap })
