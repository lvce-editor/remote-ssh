import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, firefox, webkit, expect } from '@playwright/test'
import { createFixture } from './remote-web-fixture.js'

const redact = (value = '') =>
  String(value).replace(/(ticket|token)=[^&\s"']+/g, '$1=<redacted>')

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
      if (message.type() === 'error') diagnostics.push(message.text())
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
            new URL(socket.url()).pathname !==
              '/websocket/file-system-process' ||
            Array.isArray(message.result)
          )
            diagnostics.push({
              received: new URL(socket.url()).pathname,
              id: message.id,
              hasResult: Object.hasOwn(message, 'result'),
              files: Array.isArray(message.result)
                ? message.result.map((value) => value?.name)
                : undefined,
              watcherEvent:
                message.method === 'FileWatcher.handleEvent'
                  ? message.params
                  : undefined,
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
            params: [
              'Terminal.create',
              'FileSystem.readDirWithFileTypes',
            ].includes(message.method)
              ? message.params
              : undefined,
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
    await page.keyboard.press('Control+Shift+E')
    await expect(
      page.locator('.TreeItem[aria-label="terminal-created.txt"]'),
    ).toBeVisible({ timeout: 30_000 })
    await terminalInput.pressSequentially(
      "mv terminal-created.txt renamed.txt; mkdir created-dir; printf 'RENAME_%s_OK\\n' REMOTE",
    )
    await terminalInput.press('Enter')
    await expect(terminal).toContainText('RENAME_REMOTE_OK')
    await expect(
      page.locator('.TreeItem[aria-label="renamed.txt"]'),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page.locator('.TreeItem[aria-label="created-dir"]'),
    ).toBeVisible({ timeout: 30_000 })
    await terminalInput.pressSequentially(
      "rm renamed.txt; rmdir created-dir; printf 'DELETE_%s_OK\\n' REMOTE",
    )
    await terminalInput.press('Enter')
    await expect(terminal).toContainText('DELETE_REMOTE_OK')
    await expect(
      page.locator('.TreeItem[aria-label="renamed.txt"]'),
    ).toHaveCount(0)
    await expect(
      page.locator('.TreeItem[aria-label="created-dir"]'),
    ).toHaveCount(0)
    await writeFile(
      join(fixture.workspace, 'external.txt'),
      'Remote external change\n',
    )
    await expect(
      page.locator('.TreeItem[aria-label="external.txt"]'),
    ).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Control+Shift+F')
    const search = page.locator('.Search')
    await expect(search).toBeVisible()
    await search
      .locator('textarea[name="SearchValue"]')
      .fill('Remote external change')
    await expect(search).toContainText('external.txt', { timeout: 30_000 })
    await page.keyboard.press('Control+Shift+G')
    await expect(page.locator('.SourceControl')).toContainText('hello.txt', {
      timeout: 30_000,
    })
    expect(socketPaths).toContain('/websocket/extension-node-process')
    await command('Remote Language Test: Validate TypeScript')
    await expect(page.locator('.NotificationMessage').last()).toContainText(
      '2322:',
      { timeout: 30_000 },
    )
    await page.locator('.EditorInput textarea').focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('Unsaved text must survive disconnect')
    await command('Remote Server: Disconnect')
    await expect(page.locator('.Editor')).toContainText(
      'Unsaved text must survive disconnect',
    )
    await command('Remote Server: Connection Status')
    await expect(page.locator('.NotificationMessage').last()).toContainText(
      'Disconnected',
    )
    console.log(
      `PASS ${browserName}: static HTTPS frontend, cross-origin pairing, remote save, terminal, watching, search, Git, TypeScript service, and dirty-buffer disconnect`,
    )
  } catch (error) {
    console.error(
      'Remote transport diagnostics:',
      redact(JSON.stringify(diagnostics)),
    )
    console.error('Ingress requests:', fixture.diagnostics)
    console.error('Backend:', redact(fixture.getBackendLog?.()))
    console.error(redact(await page?.locator('body').ariaSnapshot()))
    throw new Error(redact(error.stack || error.message))
  } finally {
    await browser?.close()
    await fixture.dispose()
  }
}
