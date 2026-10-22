import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, firefox, webkit, expect } from '@playwright/test'
import { createFixture } from './remote-web-fixture.js'

const fixture = await createFixture()
if (process.argv.includes('--serve')) {
  await writeFile(
    join(fixture.directory, 'connection.json'),
    JSON.stringify({
      url: fixture.url,
      pairingUrl: fixture.gateway.pairingUrl,
    }),
  )
  console.log(`Fixture: ${fixture.directory}\nFrontend: ${fixture.url}`)
  await new Promise((resolve) => {
    process.once('SIGTERM', resolve)
    process.once('SIGINT', resolve)
  })
  await fixture.dispose()
} else {
  let browser
  const diagnostics = []
  let page
  try {
    const browserName = process.env.LVCE_REMOTE_WEB_BROWSER || 'chromium'
    browser = await { chromium, firefox, webkit }[browserName].launch({
      headless: true,
      args: process.env.LVCE_REMOTE_WEB_DEBUG
        ? ['--remote-debugging-port=39229']
        : [],
    })
    page = await browser.newPage({ ignoreHTTPSErrors: true })
    const socketPaths = []
    page.on('console', (message) => {
      if (
        message.type() === 'error' ||
        message.text().startsWith('REMOTE_TRACE')
      )
        diagnostics.push(message.text())
    })
    page.on('response', (response) => {
      if (response.status() >= 400)
        diagnostics.push({
          status: response.status(),
          path: new URL(response.url()).pathname,
        })
    })
    page.on('pageerror', (error) => diagnostics.push(error.message))
    page.on('websocket', (socket) => {
      socketPaths.push(new URL(socket.url()).pathname)
      socket.on('framereceived', (event) => {
        try {
          const message = JSON.parse(String(event.payload))
          if (
            new URL(socket.url()).pathname !== '/websocket/file-system-process'
          )
            diagnostics.push({
              received: new URL(socket.url()).pathname,
              id: message.id,
              result: message.result,
              error: message.error,
            })
        } catch {
          /* Ignore non-JSON data. */
        }
      })
      socket.on('framesent', (event) => {
        try {
          const message = JSON.parse(String(event.payload))
          diagnostics.push({
            process: new URL(socket.url()).pathname,
            method: message.method,
            params:
              message.method === 'Terminal.create' ? message.params : undefined,
          })
        } catch {
          /* Binary data is not diagnostic metadata. */
        }
      })
    })
    await page.goto(fixture.url)
    await expect(
      page.getByRole('tab', { name: 'Explorer', exact: true }),
    ).toBeVisible({ timeout: 30_000 })
    const command = async (label) => {
      await page.keyboard.press('Control+Shift+P')
      const input = page.locator('.QuickPick input')
      await expect(input).toBeVisible()
      await input.fill(`>${label}`)
      await expect(
        page.getByRole('option', { name: label, exact: true }),
      ).toBeVisible()
      await page.keyboard.press('Enter')
    }
    await command('Remote Server: Connect with Pairing URL')
    const input = page.locator('.QuickPick input')
    await expect(input).toHaveAttribute(
      'placeholder',
      'Paste the HTTPS pairing URL from the remote LVCE server',
    )
    await input.fill(fixture.gateway.pairingUrl)
    await page.keyboard.press('Enter')
    const file = page.locator('.TreeItem[aria-label="hello.txt"]')
    await expect(file).toBeVisible({ timeout: 30_000 })
    await file.dblclick()
    await expect(page.locator('.Editor')).toContainText(
      'Hello from the remote machine',
    )
    await page.locator('.EditorInput textarea').focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('Saved from the browser')
    await page.keyboard.press('Control+s')
    await expect(async () =>
      expect(
        await readFile(join(fixture.workspace, 'hello.txt'), 'utf8'),
      ).toContain('Saved from the browser'),
    ).toPass()
    if (process.env.LVCE_REMOTE_WEB_DEBUG) {
      console.log('Debug browser ready on 39229')
      await new Promise((resolve) => process.once('SIGUSR1', resolve))
    }
    await page.getByRole('menuitem', { name: 'View', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click()
    const terminal = page.locator('.XtermTerminal')
    await expect(terminal).toBeVisible({ timeout: 30_000 })
    const terminalInput = terminal.locator('.xterm-helper-textarea')
    await terminal.click()
    await expect(terminalInput).toBeFocused()
    await terminalInput.pressSequentially(
      "pwd; printf 'created remotely\\n' > terminal-created.txt; printf 'REMOTE_%s_OK\\n' BROWSER",
      {
        delay: 15,
      },
    )
    await page.keyboard.press('Enter')
    await expect(terminal).toContainText('REMOTE_BROWSER_OK', {
      timeout: 30_000,
    })
    expect(
      await readFile(join(fixture.workspace, 'terminal-created.txt'), 'utf8'),
    ).toContain('created remotely')
    await expect(terminal).toContainText(fixture.workspace)
    expect(socketPaths).toContain('/websocket/terminal-process')
    await command('Remote Server: Disconnect')
    await command('Remote Server: Connection Status')
    await expect(page.locator('.NotificationMessage').last()).toContainText(
      'Disconnected',
    )
    console.log(
      `PASS ${browserName}: static HTTPS frontend, cross-origin pairing, remote file save, terminal, and disconnect`,
    )
  } catch (error) {
    console.error(
      'Remote transport diagnostics:',
      JSON.stringify(diagnostics).replace(
        /(ticket|token)=[^&\s"]+/g,
        '$1=<redacted>',
      ),
    )
    console.error('Ingress requests:', fixture.diagnostics)
    console.error(await page?.locator('body').ariaSnapshot())
    throw error
  } finally {
    await browser?.close()
    await fixture.dispose()
  }
}
