import { deepStrictEqual, throws } from 'node:assert/strict'
import { test } from 'node:test'
import { parse } from '../src/parts/RemoteSshUri/RemoteSshUri.ts'

void test('parses host, user, port, and path', () => {
  deepStrictEqual(parse('remote-ssh://user@example.com:2222/work/src'), {
    identity: '["user","example.com","2222"]',
    path: '/work/src',
    port: '2222',
    target: 'user@example.com',
  })
})

void test('decodes remote paths', () => {
  deepStrictEqual(parse('remote-ssh://example.com/work%20tree'), {
    identity: '["","example.com",""]',
    path: '/work tree',
    port: '',
    target: 'example.com',
  })
})

void test('supports IPv6 hosts', () => {
  deepStrictEqual(parse('remote-ssh://user@[2001:db8::1]/'), {
    identity: '["user","[2001:db8::1]",""]',
    path: '/',
    port: '',
    target: 'user@[2001:db8::1]',
  })
})

void test('rejects invalid and cross-scheme uris', () => {
  throws(() => parse('not a uri'), /Invalid Remote SSH URI/)
  throws(() => parse('file:///work'), /Expected remote-ssh URI/)
  throws(() => parse('remote-ssh:///work'), /has no host/)
  throws(
    () => parse('remote-ssh://user:password@example.com/'),
    /Passwords are not allowed/,
  )
})

void test('rejects targets that OpenSSH could interpret as options', () => {
  throws(
    () => parse('remote-ssh://-oProxyCommand=echo/'),
    /SSH target must not start with a hyphen/,
  )
  throws(
    () => parse('remote-ssh://-oProxyCommand%3Decho@example.com/'),
    /SSH target must not start with a hyphen/,
  )
})
