import { strictEqual } from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import {
  connect,
  readFile,
  writeFile,
} from '../../../node/src/parts/SshFileSystem/SshFileSystem.ts'
import {
  configure,
  dispose,
  getConnectionProgress,
  connectWorkspaceBackend,
} from '../../../node/src/parts/SshTransport/SshTransport.ts'
import { parse } from '../../../node/src/parts/RemoteSshUri/RemoteSshUri.ts'
import { create } from '../../../node/src/parts/WorkspaceBackendRpc/WorkspaceBackendRpc.ts'
import * as SshProcessRegistry from '../../../node/src/parts/SshProcessRegistry/SshProcessRegistry.ts'

const [uri, mode] = process.argv.slice(2)
const location = parse(uri)
configure(mode === 'foreground' ? 'foreground' : 'background')
let rpc
const cancelled =
  mode === 'cancel'
    ? new Promise((resolve) => process.once('message', resolve))
    : undefined
try {
  const [backend, shared] = await Promise.all([connect(uri), connect(uri)])
  strictEqual(backend.url, shared.url)
  await writeFile(`${uri}/during-update.txt`, 'saved before download finished')
  strictEqual(
    Buffer.from(
      await readFile(`${uri}/during-update.txt`),
      'base64',
    ).toString(),
    'saved before download finished',
  )
  const endpoint = new URL('/websocket/file-system-process', backend.url)
  endpoint.searchParams.set('token', backend.token)
  rpc = create(endpoint.href)
  strictEqual(
    await rpc.invoke(
      'FileSystem.readFile',
      `file://${location.path}/during-update.txt`,
      'utf8',
    ),
    'saved before download finished',
  )
  process.send({ type: 'usable', backend })
  if (mode === 'cancel') await cancelled
  if (mode === 'background' || mode === 'failure') {
    const expected =
      mode === 'failure'
        ? 'background update failed'
        : 'updated in the background'
    const deadline = Date.now() + 30000
    while (!getConnectionProgress(location).includes(expected)) {
      if (Date.now() > deadline)
        throw new Error(
          `No update completion: ${getConnectionProgress(location)}`,
        )
      await delay(20)
    }
    strictEqual((await connectWorkspaceBackend(location)).url, backend.url)
    await writeFile(`${uri}/after-update.txt`, 'saved after handover')
    // The previously opened backend socket must still work after switching.
    strictEqual(
      await rpc.invoke(
        'FileSystem.readFile',
        `file://${location.path}/after-update.txt`,
        'utf8',
      ),
      'saved after handover',
    )
    strictEqual(
      Buffer.from(
        await readFile(`${uri}/after-update.txt`),
        'base64',
      ).toString(),
      'saved after handover',
    )
    process.send({
      type: 'validated',
      progress: getConnectionProgress(location),
    })
  }
} finally {
  rpc?.dispose()
  dispose()
  await SshProcessRegistry.dispose()
  process.disconnect()
}
