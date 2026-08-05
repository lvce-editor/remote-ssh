import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import {
  getSshConfigHosts,
  parseSshConfigHosts,
} from '../src/parts/SshConfigHosts/SshConfigHosts.ts'

void test('parses literal hosts in config order', () => {
  deepStrictEqual(
    parseSshConfigHosts(`
Host work staging
  HostName example.com
host=personal
HOST "quoted-host" 'single-quoted-host' # local aliases
Host work
`),
    ['work', 'staging', 'personal', 'quoted-host', 'single-quoted-host'],
  )
})

void test('ignores wildcard, negated, empty, and malformed host entries', () => {
  deepStrictEqual(
    parseSshConfigHosts(`
Host *
Host *.example.com
Host !blocked.example.com allowed.example.com
Host
Host "unterminated
Hostname not-a-host-entry.example.com
`),
    ['allowed.example.com'],
  )
})

void test('handles comments, CRLF, and case-insensitive duplicates', () => {
  deepStrictEqual(
    parseSshConfigHosts(
      'Host first # comment\r\nHost second\r\nHost FIRST\r\n',
    ),
    ['first', 'second'],
  )
})

void test('reads the config from the current user home directory', async () => {
  let receivedPath = ''
  let receivedEncoding = ''
  const hosts = await getSshConfigHosts(async (path, encoding) => {
    receivedPath = path
    receivedEncoding = encoding
    return 'Host work'
  }, '/users/test-user')

  deepStrictEqual(hosts, ['work'])
  strictEqual(receivedPath, '/users/test-user/.ssh/config')
  strictEqual(receivedEncoding, 'utf8')
})

void test('returns no hosts when the config is missing or unreadable', async () => {
  const hosts = await getSshConfigHosts(async () => {
    throw new Error('ENOENT')
  }, '/users/test-user')

  deepStrictEqual(hosts, [])
})
