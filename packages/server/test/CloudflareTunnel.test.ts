import {
  deepStrictEqual,
  strictEqual,
  rejects,
  throws,
} from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { enable, disable, validateBackendUrl } from '../src/CloudflareTunnel.ts'

void test('backend URLs reject insecure public origins and credential-bearing URLs', () => {
  for (const url of [
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com/?secret=1',
  ])
    throws(() => validateBackendUrl(url))
  strictEqual(
    validateBackendUrl('https://backend.example'),
    'https://backend.example',
  )
})
void test(
  'CLI approval exchanges only machine credentials and disposes its connector',
  { skip: process.platform === 'win32' },
  async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lvce-cloudflare-'))
    const id = 'a'.repeat(32),
      token = 'tunnel-only-secret'
    const calls: { path: string; authorization?: string }[] = []
    let credentialHash = ''
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      calls.push({ path: req.url!, authorization: req.headers.authorization })
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/cloudflare/requests') {
        credentialHash = body.secretHash
        res.end(
          JSON.stringify({
            id,
            code: 'ABCDEF12',
            verificationUrl: `${backendUrl}/cloudflare/setup/${id}`,
          }),
        )
      } else {
        const credential =
          req.headers.authorization?.slice('Bearer '.length) || ''
        strictEqual(
          createHash('sha256').update(credential).digest('hex'),
          credentialHash,
        )
        res.end(
          JSON.stringify(
            req.url?.endsWith('/poll')
              ? {
                  status: 'ready',
                  persistent: true,
                  hostname: 'lvce.example.com',
                  tunnelToken: token,
                }
              : { disabled: true },
          ),
        )
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const backendUrl = `http://127.0.0.1:${address.port}`
    context.after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    })
    const binary = path.join(directory, 'cloudflared')
    await writeFile(binary, '#!/bin/sh\nexec sleep 120\n', { mode: 0o700 })
    const statePath = path.join(directory, 'state.json')
    const output: string[] = []
    const tunnel = await enable({
      backendUrl,
      port: 3774,
      statePath,
      cloudflaredPath: binary,
      signal: new AbortController().signal,
      output: (message) => output.push(message),
    })
    try {
      strictEqual(tunnel.publicUrl, 'https://lvce.example.com')
      strictEqual(tunnel.persistent, true)
      strictEqual((await stat(statePath)).mode & 0o777, 0o600)
      strictEqual((await stat(`${statePath}.token`)).mode & 0o777, 0o600)
      strictEqual(await readFile(`${statePath}.token`, 'utf8'), token)
      strictEqual(output.join('').includes(token), false)
      strictEqual(output.join('').includes('ABCDEF12'), true)
      await rejects(
        enable({
          backendUrl,
          port: 3774,
          statePath,
          cloudflaredPath: binary,
          signal: new AbortController().signal,
          output: () => {},
        }),
        /already running/,
      )
    } finally {
      await tunnel.close()
    }
    const resumedOutput: string[] = []
    const resumed = await enable({
      backendUrl,
      port: 3774,
      statePath,
      cloudflaredPath: binary,
      signal: new AbortController().signal,
      output: (message) => resumedOutput.push(message),
    })
    try {
      strictEqual(resumed.publicUrl, tunnel.publicUrl)
      strictEqual(resumedOutput.join('').includes('Reconnecting'), true)
      strictEqual(
        calls.filter((call) => call.path === '/cloudflare/requests').length,
        1,
      )
    } finally {
      await resumed.close()
    }
    await disable(statePath)
    await disable(statePath)
    await rejects(stat(`${statePath}.token`), { code: 'ENOENT' })
    await rejects(stat(statePath), { code: 'ENOENT' })
    deepStrictEqual(
      calls.map((item) => item.path),
      [
        '/cloudflare/requests',
        `/cloudflare/requests/${id}/poll`,
        `/cloudflare/requests/${id}/browser-access/register`,
        `/cloudflare/requests/${id}/poll`,
        `/cloudflare/requests/${id}/browser-access/register`,
        `/cloudflare/requests/${id}/disable`,
      ],
    )
  },
)

void test('an untrusted approval response cannot persist credentials or leave a setup lock', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lvce-cloudflare-'))
  const statePath = path.join(directory, 'state.json')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json({
      id: 'a'.repeat(32),
      code: 'ABCDEF12',
      verificationUrl:
        'https://attacker.example/cloudflare/setup/' + 'a'.repeat(32),
    })
  context.after(async () => {
    globalThis.fetch = originalFetch
    await rm(directory, { recursive: true, force: true })
  })
  await rejects(
    enable({
      backendUrl: 'https://backend.example',
      port: 3774,
      statePath,
      cloudflaredPath: '/unused',
      signal: new AbortController().signal,
      output: () => {},
    }),
    /Invalid Cloudflare approval URL/,
  )
  await rejects(stat(statePath), { code: 'ENOENT' })
  await rejects(stat(statePath + '.lock'), { code: 'ENOENT' })
})

void test('expired saved enrollment is disabled before a fresh approval is printed', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lvce-cloudflare-'))
  const statePath = path.join(directory, 'state.json')
  const backendUrl = 'https://backend.example'
  const oldId = 'a'.repeat(32)
  const newId = 'b'.repeat(32)
  const saved = { backendUrl, id: oldId, secret: 'c'.repeat(43) }
  await writeFile(statePath, JSON.stringify(saved), { mode: 0o600 })
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  const output: string[] = []
  const freshPoll = new Error('Fresh approval was polled')
  globalThis.fetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname
    calls.push(pathname)
    await stat(`${statePath}.lock/owner`)
    if (pathname === `/cloudflare/requests/${oldId}/poll`)
      return Response.json({}, { status: 410 })
    if (pathname === `/cloudflare/requests/${oldId}/disable`) {
      strictEqual(
        new Headers(init?.headers).get('Authorization'),
        `Bearer ${saved.secret}`,
      )
      return Response.json({ disabled: true })
    }
    if (pathname === '/cloudflare/requests') {
      strictEqual(JSON.parse(await readFile(statePath, 'utf8')).id, oldId)
      return Response.json({
        id: newId,
        code: 'ABCDEF12',
        verificationUrl: `${backendUrl}/cloudflare/setup/${newId}`,
      })
    }
    strictEqual(pathname, `/cloudflare/requests/${newId}/poll`)
    throw freshPoll
  }
  context.after(async () => {
    globalThis.fetch = originalFetch
    await rm(directory, { recursive: true, force: true })
  })
  await rejects(
    enable({
      backendUrl,
      port: 3774,
      statePath,
      cloudflaredPath: '/unused',
      signal: new AbortController().signal,
      output: (message) => output.push(message),
    }),
    (error) => error === freshPoll,
  )
  deepStrictEqual(calls, [
    `/cloudflare/requests/${oldId}/poll`,
    `/cloudflare/requests/${oldId}/disable`,
    '/cloudflare/requests',
    `/cloudflare/requests/${newId}/poll`,
  ])
  const replacement = JSON.parse(await readFile(statePath, 'utf8'))
  strictEqual(replacement.id, newId)
  strictEqual(replacement.secret === saved.secret, false)
  strictEqual(
    output.join('').includes(`${backendUrl}/cloudflare/setup/${newId}`),
    true,
  )
  await rejects(stat(`${statePath}.lock`), { code: 'ENOENT' })
})

for (const status of [401, 403, 503]) {
  void test(`saved credentials survive HTTP ${status} without automatic enrollment`, async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lvce-cloudflare-'))
    const statePath = path.join(directory, 'state.json')
    const backendUrl = 'https://backend.example'
    const saved = { backendUrl, id: 'a'.repeat(32), secret: 'c'.repeat(43) }
    const contents = JSON.stringify(saved)
    await writeFile(statePath, contents, { mode: 0o600 })
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = async (input) => {
      calls.push(new URL(String(input)).pathname)
      return Response.json({}, { status })
    }
    context.after(async () => {
      globalThis.fetch = originalFetch
      await rm(directory, { recursive: true, force: true })
    })
    await rejects(
      enable({
        backendUrl,
        port: 3774,
        statePath,
        cloudflaredPath: '/unused',
        signal: new AbortController().signal,
        output: () => {},
      }),
      new RegExp(`HTTP ${status}`),
    )
    deepStrictEqual(calls, [`/cloudflare/requests/${saved.id}/poll`])
    strictEqual(await readFile(statePath, 'utf8'), contents)
    await rejects(stat(`${statePath}.lock`), { code: 'ENOENT' })
  })
}

void test('failed expired-enrollment cleanup preserves the only management credential', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lvce-cloudflare-'))
  const statePath = path.join(directory, 'state.json')
  const backendUrl = 'https://backend.example'
  const saved = { backendUrl, id: 'a'.repeat(32), secret: 'c'.repeat(43) }
  const contents = JSON.stringify(saved)
  await writeFile(statePath, contents, { mode: 0o600 })
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname
    calls.push(pathname)
    return Response.json({}, { status: pathname.endsWith('/poll') ? 410 : 503 })
  }
  context.after(async () => {
    globalThis.fetch = originalFetch
    await rm(directory, { recursive: true, force: true })
  })
  await rejects(
    enable({
      backendUrl,
      port: 3774,
      statePath,
      cloudflaredPath: '/unused',
      signal: new AbortController().signal,
      output: () => {},
    }),
    /HTTP 503/,
  )
  deepStrictEqual(calls, [
    `/cloudflare/requests/${saved.id}/poll`,
    `/cloudflare/requests/${saved.id}/disable`,
  ])
  strictEqual(await readFile(statePath, 'utf8'), contents)
  await rejects(stat(`${statePath}.lock`), { code: 'ENOENT' })
})
