import { match, strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { create } from '../src/parts/ConnectionError/ConnectionError.ts'

for (const [detail, code] of [
  [
    'ssh: connect to host example.com port 22: Connection timed out',
    'E_SSH_HOST_UNREACHABLE',
  ],
  ['Network is unreachable', 'E_SSH_HOST_UNREACHABLE'],
  ['Could not resolve hostname example.com', 'E_SSH_HOST_NOT_FOUND'],
  ['Host key verification failed', 'E_SSH_HOST_KEY_FAILED'],
  ['user@host: Permission denied (publickey)', 'E_SSH_AUTHENTICATION_FAILED'],
  ['Connection refused', 'E_SSH_CONNECTION_REFUSED'],
  ['spawn /usr/bin/ssh ENOENT', 'E_SSH_CONNECT_FAILED'],
]) {
  void test(`classifies SSH diagnostic: ${detail}`, () => {
    const cause = new Error(detail)
    const error = create('example.com', 'connect', cause, '/server.log')
    strictEqual(error.code, code)
    strictEqual(error.cause, cause)
    strictEqual(error.message.includes(detail), true)
    strictEqual(error.message.startsWith('example.com:'), true)
  })
}

void test('does not mistake server permission errors for rejected SSH authentication', () => {
  const error = create(
    'host',
    'install',
    new Error('mkdir: Permission denied (publickey)'),
    '/server.log',
  )
  strictEqual(error.code, 'E_SSH_INSTALL_FAILED')
  match(error.message, /SSH connected/)
})

void test('explains when the requested LVCE server version is not available on npm', () => {
  const cause = new Error(
    [
      'npm error code ETARGET',
      'npm error notarget No matching version found for @lvce-editor/server@0.125.0.',
    ].join('\n'),
  )
  const error = create('host', 'install', cause, '/server.log')
  strictEqual(error.code, 'E_SSH_SERVER_VERSION_NOT_FOUND')
  strictEqual(error.cause, cause)
  match(error.message, /may still be going through publication checks/)
  match(error.message, /try again in a few minutes/)
  strictEqual(error.message.includes('ETARGET'), false)
  strictEqual(error.message.includes('disk space'), false)
  strictEqual(error.message.includes('permissions'), false)
})

void test('does not classify a missing unrelated npm package as a server version error', () => {
  const error = create(
    'host',
    'install',
    new Error(
      'npm error code ETARGET\nnpm error notarget No matching version found for unrelated-package@1.0.0.',
    ),
    '/server.log',
  )
  strictEqual(error.code, 'E_SSH_INSTALL_FAILED')
  match(error.message, /disk space/)
})

void test('removes npm progress bars from displayed installation details', () => {
  const error = create(
    'host',
    'install',
    new Error('#####\n################ 100.0%\nnpm error code ECONNRESET'),
    '/server.log',
  )
  strictEqual(error.message.includes('#'), false)
  match(error.message, /npm error code ECONNRESET/)
})

void test('identifies startup and backend failures with the remote log path', () => {
  for (const stage of ['start', 'backend'] as const) {
    const error = create(
      'host',
      stage,
      new Error('backend exited'),
      '/remote/run/server-v1.log',
    )
    match(error.message, /SSH connected/)
    match(error.message, /\/remote\/run\/server-v1.log/)
    match(error.message, /backend exited/)
  }
})
