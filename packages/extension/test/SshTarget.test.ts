import { expect, test } from '@jest/globals'
import { toRemoteSshUri } from '../src/parts/SshTarget/SshTarget.ts'

test.each([
  ['example.com', 'remote-ssh://example.com/'],
  ['user@example.com', 'remote-ssh://user@example.com/'],
  ['example.com:/work/project', 'remote-ssh://example.com/work/project'],
  ['ssh example.com', 'remote-ssh://example.com/'],
  ['ssh -p 2222 user@example.com', 'remote-ssh://user@example.com:2222/'],
  ['ssh -l user example.com', 'remote-ssh://user@example.com/'],
  [
    'ssh://user@example.com:2222/work',
    'remote-ssh://user@example.com:2222/work',
  ],
  ['[2001:db8::1]', 'remote-ssh://[2001:db8::1]/'],
])('maps %p to %p', (input, expected) => {
  expect(toRemoteSshUri(input)).toBe(expected)
})

test.each([
  '',
  'ssh',
  'ssh -i key example.com',
  'ssh one.example.com two.example.com',
  'ssh -p 0 example.com',
  'ssh -p 70000 example.com',
  'ssh -l user other@example.com',
  'ssh://user:password@example.com',
  'ssh://example.com/?token=secret',
])('rejects invalid target %p', (input) => {
  expect(() => toRemoteSshUri(input)).toThrow()
})
