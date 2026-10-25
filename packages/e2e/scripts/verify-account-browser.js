import { expect } from '@playwright/test'

// Backend ownership and grant signing are covered by backend-2's integration
// tests. This exercises the real HTTPS browser exchange and remote filesystem.
export const verifyAccountBrowser = async (
  context,
  fixture,
  contextOptions,
) => {
  const second = await context.browser().newContext(contextOptions)
  try {
    const page = await second.newPage()
    await page.goto(new URL('account-browser-test.html', fixture.url).href)
    const result = await page.evaluate(
      async ({ pairingUrl, authorization, workspace }) => {
        const origin = new URL(pairingUrl).origin
        const post = (path, token) =>
          fetch(new URL(path, origin), {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'x-lvce-protocol': '1',
            },
          })
        const response = await post('/auth/account', authorization)
        if (!response.ok)
          throw new Error(`Account exchange failed (${response.status})`)
        const session = await response.json()
        const replay = await post('/auth/account', authorization)
        const ticketResponse = await post(
          '/auth/websocket-ticket?process=file-system-process',
          session.sessionToken,
        )
        const { ticket } = await ticketResponse.json()
        const url = new URL(
          '/websocket/file-system-process',
          session.websocketUrl,
        )
        url.searchParams.set('ticket', ticket)
        const type = await new Promise((resolve, reject) => {
          const socket = new WebSocket(url)
          const timeout = setTimeout(() => {
            socket.close()
            reject(new Error('Account file read timed out'))
          }, 15_000)
          socket.onopen = () =>
            socket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'FileSystem.readFile',
                params: [`file://${workspace}/hello.txt`, 'utf8'],
              }),
            )
          socket.onmessage = (event) => {
            const message = JSON.parse(String(event.data))
            if (message.id !== 1) return
            clearTimeout(timeout)
            socket.close()
            if (message.error) reject(new Error('Account file read failed'))
            else resolve(message.result)
          }
          socket.onerror = () => {
            clearTimeout(timeout)
            socket.close()
            reject(new Error('Account socket failed'))
          }
        })
        const revoked = await post('/auth/revoke', session.sessionToken)
        return {
          text: type,
          replayStatus: replay.status,
          revokedStatus: revoked.status,
        }
      },
      {
        pairingUrl: fixture.gateway.pairingUrl,
        authorization: fixture.authorizeBrowser(),
        workspace: fixture.workspace,
      },
    )
    expect(result).toEqual({
      text: 'Hello from the remote machine\n',
      replayStatus: 401,
      revokedStatus: 200,
    })
  } finally {
    await second.close()
  }
}
