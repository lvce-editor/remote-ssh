import { strictEqual, match } from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createRemoteWebGateway } from '../src/RemoteWebGateway.ts'

const origin = 'https://lvce-editor.github.io'
void test('HTTP previews preserve targets, isolate grants and revoke with the session', async (t) => {
  let received = ''
  const app = createServer((req, res) => {
    received = req.url || ''
    strictEqual(req.headers.authorization, undefined)
    strictEqual(req.headers.cookie, undefined)
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/nested/page?value=1#section' })
      res.end()
      return
    }
    res.end('<h1>Remote application</h1>')
  }).listen(0, '127.0.0.1')
  await once(app, 'listening')
  t.after(() => new Promise<void>((resolve) => app.close(() => resolve())))
  const port = (app.address() as { port: number }).port
  const gateway = await createRemoteWebGateway({
    allowedOrigin: origin,
    backendPort: 1,
    backendToken: 'internal',
    port: 0,
    publicUrl: 'https://remote.example.com',
    workspacePath: '/workspace',
  })
  t.after(() => gateway.close())
  const local = `http://127.0.0.1:${gateway.localPort}`
  const post = (path: string, token: string, requestOrigin = origin) =>
    fetch(local + path, {
      method: 'POST',
      headers: {
        origin: requestOrigin,
        authorization: `Bearer ${token}`,
        'x-lvce-protocol': '1',
      },
    })
  const pair = await post(
    '/auth/pair',
    new URL(gateway.pairingUrl!).hash.slice(7),
  )
  const { sessionToken } = (await pair.json()) as { sessionToken: string }
  strictEqual(
    (await post(`/auth/http-preview?port=${port}`, 'invalid')).status,
    401,
  )
  strictEqual(
    (
      await post(
        `/auth/http-preview?port=${port}`,
        sessionToken,
        'https://evil.example.com',
      )
    ).status,
    403,
  )
  for (const invalid of [0, -1, 65536, 1, gateway.localPort])
    strictEqual(
      (await post(`/auth/http-preview?port=${invalid}`, sessionToken)).status,
      400,
    )
  const result = await post(`/auth/http-preview?port=${port}`, sessionToken)
  strictEqual(result.status, 200)
  const { previewUrl } = (await result.json()) as { previewUrl: string }
  const prefix = new URL(previewUrl).pathname.slice(0, -1)
  match(prefix, /^\/preview\/[a-f0-9]{64}$/)
  strictEqual(previewUrl.includes(sessionToken), false)
  const page = await fetch(`${local}${prefix}/nested/page?value=a%20b`, {
    headers: { authorization: 'not-forwarded', cookie: 'not-forwarded' },
  })
  strictEqual(page.status, 200)
  match(await page.text(), /Remote application/)
  strictEqual(received, '/nested/page?value=a%20b')
  strictEqual(
    (
      await fetch(local + '/asset.css', {
        headers: { referer: 'https://evil.example.com' },
        redirect: 'manual',
      })
    ).status,
    403,
  )
  const asset = await fetch(local + '/asset.css', {
    headers: { referer: `${previewUrl}nested/page` },
    redirect: 'manual',
  })
  strictEqual(asset.status, 307)
  strictEqual(asset.headers.get('location'), `${prefix}/asset.css`)
  const redirect = await fetch(local + prefix + '/redirect', {
    redirect: 'manual',
  })
  strictEqual(
    redirect.headers.get('location'),
    `${prefix}/nested/page?value=1#section`,
  )
  const other = await createRemoteWebGateway({
    allowedOrigin: origin,
    backendPort: 1,
    backendToken: 'other',
    port: 0,
    publicUrl: 'https://other.example.com',
    workspacePath: '/other',
  })
  t.after(() => other.close())
  strictEqual(
    (await fetch(`http://127.0.0.1:${other.localPort}${prefix}/`)).status,
    401,
  )
  strictEqual((await post('/auth/revoke', sessionToken)).status, 200)
  const expired = await fetch(local + prefix + '/')
  strictEqual(expired.status, 401)
  match(await expired.text(), /expired or disconnected/)
})
