import { match, strictEqual, throws } from 'node:assert/strict'
import { test } from 'node:test'
import {
  _getRemoteCommand,
  _getSshArgs,
  _validatePort,
} from '../src/parts/SshTransport/SshTransport.ts'

void test('keeps the SSH master in the foreground with stdin connected', () => {
  const args = _getSshArgs({
    identity: '["user","example.com","2222"]',
    path: '/',
    port: '2222',
    target: 'user@example.com',
  })

  strictEqual(args[0], '-M')
  strictEqual(args.includes('-S'), true)
  strictEqual(args.includes('-T'), true)
  const portIndex = args.indexOf('-p')
  strictEqual(args[portIndex + 1], '2222')
  strictEqual(args.includes('ControlPersist=no'), true)
  strictEqual(args.includes('ForkAfterAuthentication=no'), true)
  strictEqual(args.includes('StdinNull=no'), true)
  strictEqual(args.at(-2), 'user@example.com')
  match(args.at(-1) || '', /connect-or-start/)
  match(args.at(-1) || '', /__LVCE_REMOTE_SSH_INSTALL_REQUIRED__/)
})

void test('lets OpenSSH select its configured port for bare targets', () => {
  const args = _getSshArgs({
    identity: '["","example.com",""]',
    path: '/',
    port: '',
    target: 'example.com',
  })

  strictEqual(args.includes('-p'), false)
})

void test('uses versioned private runtime and server paths', () => {
  const command = _getRemoteCommand()
  match(command, /\$root\/runtimes\/v24\.15\.0\/bin\/node/)
  match(command, /\$root\/servers\/dev\/lvce-remote-ssh-server\.mjs/)
  match(command, /LVCE_REMOTE_SSH_CLIENT_VERSION='dev'/)
  strictEqual(command.includes('python'), false)
})

void test('validates forwarded port numbers before opening an SSH connection', () => {
  for (const port of [1, 3000, 65_535]) {
    _validatePort(port)
  }
  for (const port of [0, -1, 65_536, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    throws(() => _validatePort(port), {
      message: 'Remote port must be between 1 and 65535',
      name: 'TypeError',
    })
  }
})
