import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect } from '@playwright/test'

export const verifyHttpPreview = async (
  page,
  fixture,
  terminalInput,
  terminal,
) => {
  const requests = []
  const app = createServer((request, response) => {
    requests.push(request.url)
    response.setHeader(
      'content-type',
      request.url === '/asset.js' ? 'text/javascript' : 'text/html',
    )
    response.end(
      request.url === '/asset.js'
        ? "document.querySelector('h1').textContent = 'Remote HTTP preview ready'"
        : '<h1>Loading remote preview</h1><script src="/asset.js"></script>',
    )
  }).listen(0, '127.0.0.1')
  await once(app, 'listening')
  try {
    const port = app.address().port
    const target = `http://127.0.0.1:${port}/nested?q=one%20two#part`
    if (process.env.LVCE_REMOTE_WEB_TERMINAL_PREVIEW === '1') {
      // This integrated regression is enabled by the consuming LVCE workflow once
      // its renderer includes the iframe host. The producer also runs gateway
      // iframe coverage below against the currently released frontend.
      await terminalInput.pressSequentially(`printf '\\n${target}\\n'`)
      await terminalInput.press('Enter')
      const link = terminal.getByText(target, { exact: true }).last()
      await expect(link).toBeVisible()
      await link.hover()
      await link.click()
      const frame = page.locator('.SimpleBrowserHtmlPreview iframe')
      await expect(frame).toBeVisible({ timeout: 30_000 })
      await expect(frame.contentFrame().getByRole('heading')).toHaveText(
        'Remote HTTP preview ready',
      )
      await expect(frame).toHaveAttribute('src', /\/nested\?q=one%20two#part$/)
      await page.evaluate(async () => {
        const { executeCommand } = await import(
          document.querySelector('script[type="module"][src]').src
        )
        return executeCommand('Layout.hidePreview')
      })
    }
    const probe = await page.context().newPage()
    try {
      await probe.goto(new URL('account-browser-test.html', fixture.url).href)
      await probe.evaluate(
        async ({ pairingUrl, port }) => {
          const endpoint = new URL(pairingUrl)
          const token = new URLSearchParams(endpoint.hash.slice(1)).get('token')
          endpoint.hash = ''
          const post = async (path, authorization) => {
            const response = await fetch(new URL(path, endpoint), {
              method: 'POST',
              headers: {
                authorization: `Bearer ${authorization}`,
                'x-lvce-protocol': '1',
              },
            })
            if (!response.ok)
              throw new Error(`Preview probe HTTP ${response.status}`)
            return response.json()
          }
          const { sessionToken } = await post('/auth/pair', token)
          const { previewUrl } = await post(
            `/auth/http-preview?port=${port}`,
            sessionToken,
          )
          const iframe = document.createElement('iframe')
          iframe.sandbox = 'allow-scripts allow-forms allow-same-origin'
          iframe.src = previewUrl + 'nested?q=one%20two#part'
          document.body.append(iframe)
          window.revokePreviewProbe = () => post('/auth/revoke', sessionToken)
        },
        { pairingUrl: fixture.gateway.pair(), port },
      )
      const frame = probe.locator('iframe')
      await expect(frame.contentFrame().getByRole('heading')).toHaveText(
        'Remote HTTP preview ready',
      )
      expect(requests).toContain('/nested?q=one%20two')
      expect(requests).toContain('/asset.js')
      await probe.evaluate(() => window.revokePreviewProbe())
      await frame.evaluate((iframe) => {
        iframe.src = iframe.src
      })
      await expect(frame.contentFrame().locator('body')).toContainText(
        'Preview expired or disconnected',
      )
    } finally {
      await probe.close()
    }
  } finally {
    app.closeAllConnections()
    await new Promise((resolve) => app.close(resolve))
  }
}
