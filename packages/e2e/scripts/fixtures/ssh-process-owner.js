import { connectWorkspaceBackend } from '../../../node/src/parts/SshTransport/SshTransport.ts'
import { parse } from '../../../node/src/parts/RemoteSshUri/RemoteSshUri.ts'
import { toRemoteSshUri } from '../../../extension/src/parts/SshTarget/SshTarget.ts'
import { dispose } from '../../../node/src/parts/SshProcessRegistry/SshProcessRegistry.ts'

import '../../../node/src/remoteSshProcess.ts'
const backend = await connectWorkspaceBackend(
  parse(toRemoteSshUri(process.argv[2])),
)
console.log(JSON.stringify(backend))
process.stdin.once('data', async () => {
  await dispose()
  process.exit(0)
})
