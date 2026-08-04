import { deepStrictEqual, throws } from 'node:assert/strict'
import { test } from 'node:test'
import { marker } from '../src/parts/RemoteHelper/RemoteHelper.ts'
import {
  _getSshArgs,
  _parseResponse,
} from '../src/parts/SshTransport/SshTransport.ts'

void test('builds non-interactive OpenSSH arguments', () => {
  const args = _getSshArgs({
    identity: '["user","example.com","2222"]',
    path: '/',
    port: '2222',
    target: 'user@example.com',
  })

  deepStrictEqual(args.slice(0, 11), [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-p',
    '2222',
    'user@example.com',
    args[10],
  ])
})

void test('parses a marked helper response after login output', () => {
  deepStrictEqual(
    _parseResponse(`Welcome\n${marker}{"ok":true,"result":[1]}\n`),
    { ok: true, result: [1] },
  )
})

void test('rejects missing and invalid helper responses', () => {
  throws(() => _parseResponse('Welcome\n'), /no response/)
  throws(() => _parseResponse(`${marker}{bad json}`), /invalid response/)
})
