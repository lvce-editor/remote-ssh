import { rejects, strictEqual } from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as Control from '../src/RemoteWebControl.ts'

void test(
  'owner-only local control rotates pairing and revokes sessions without restarting the gateway',
  { skip: process.platform === 'win32' },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'lvce-web-control-'))
    const socketPath = join(root, 'control.sock')
    let pairings = 0
    let revocations = 0
    const close = await Control.listen(socketPath, {
      close: async () => {},
      localPort: 3774,
      pair: () => `https://remote.example/#token=pair-${++pairings}`,
      pairingUrl: '',
      revoke: () => {
        revocations++
      },
    })
    context.after(async () => {
      await close()
      await rm(root, { force: true, recursive: true })
    })
    strictEqual((await stat(socketPath)).mode & 0o777, 0o600)
    strictEqual(
      JSON.parse(await Control.request(socketPath, 'pair')).pairingUrl,
      'https://remote.example/#token=pair-1',
    )
    strictEqual(
      JSON.parse(await Control.request(socketPath, 'pair')).pairingUrl,
      'https://remote.example/#token=pair-2',
    )
    strictEqual(
      JSON.parse(await Control.request(socketPath, 'revoke')).ok,
      true,
    )
    strictEqual(revocations, 1)
  },
)

void test(
  'managed pairing refusal is returned without crashing local control',
  { skip: process.platform === 'win32' },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'lvce-web-control-'))
    const socketPath = join(root, 'control.sock')
    const close = await Control.listen(socketPath, {
      close: async () => {},
      localPort: 3774,
      pair: () => {
        throw new Error('Managed tunnels require LVCE account sign-in')
      },
      revoke: () => {},
    })
    context.after(async () => {
      await close()
      await rm(root, { force: true, recursive: true })
    })
    await rejects(
      Control.request(socketPath, 'pair'),
      /require LVCE account sign-in/,
    )
    strictEqual(
      JSON.parse(await Control.request(socketPath, 'revoke')).ok,
      true,
    )
  },
)
