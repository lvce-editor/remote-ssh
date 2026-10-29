import { verifyDirectoryCache } from './verify-directory-cache.js'
import { verifyHttpPreview } from './verify-http-preview.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, firefox, webkit, expect } from '@playwright/test'
import { WebSocket } from 'ws'
import { verifyAccountBrowser } from './verify-account-browser.js'
import { createFixture } from './remote-web-fixture.js'

const redact = (value = '') =>
  String(value)
    .replace(/(ticket|token)=[^&\s"']+/g, '$1=<redacted>')
    .replace(/\/preview\/[a-f0-9]{64}/g, '/preview/<redacted>')

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
  let context
  const diagnostics = []
  const expectedSearchFailures = new Map()
  let page
  try {
    const cliFolders = [
      join(fixture.workspace, 'cli-first'),
      join(fixture.workspace, 'cli folder with spaces'),
    ]
    for (const [index, path] of cliFolders.entries()) {
      await mkdir(path)
      await writeFile(
        join(path, `opened-by-cli-${index + 1}.txt`),
        'opened remotely',
      )
    }
    const browserName = process.env.LVCE_REMOTE_WEB_BROWSER || 'chromium'
    const launchOptions = {
      headless: true,
      ...(browserName === 'firefox' && !fixture.injectedLanguage
        ? { firefoxUserPrefs: { 'network.lna.skip-domains': 'localhost' } }
        : {}),
      args: process.env.LVCE_REMOTE_WEB_DEBUG
        ? ['--remote-debugging-port=39229']
        : [],
    }
    const contextOptions = {
      ignoreHTTPSErrors: true,
      ...(browserName === 'chromium' && !fixture.injectedLanguage
        ? { permissions: ['local-network-access'] }
        : {}),
    }
    if (browserName === 'webkit') {
      // WebKit's ephemeral context discards Cache Storage on navigation.
      context = await webkit.launchPersistentContext(
        join(fixture.directory, 'browser-profile'),
        { ...launchOptions, ...contextOptions },
      )
    } else {
      browser = await { chromium, firefox }[browserName].launch(launchOptions)
      context = await browser.newContext(contextOptions)
    }
    page = await context.newPage()
    const socketPaths = []
    let remoteCliWaiterCount = 0
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const url = message.location().url
      const expected = expectedSearchFailures.get(url) || 0
      if (
        expected > 0 &&
        message.text() ===
          'Failed to load resource: the server responded with a status of 503 (Service Unavailable)'
      ) {
        expectedSearchFailures.set(url, expected - 1)
        diagnostics.push({ expectedSearchFailure: new URL(url).pathname })
        return
      }
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
          if (message === 'ready')
            diagnostics.push({
              unexpectedReadiness: new URL(socket.url()).pathname,
            })
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
          if (message.method === 'RemoteCli.waitForOpenRequest') {
            remoteCliWaiterCount++
          }
          diagnostics.push({
            process: new URL(socket.url()).pathname,
            method: message.method,
            params: [
              'Terminal.create',
              'FileSystem.readDirWithFileTypes',
              'FileSystem.getDirectoryVersion',
            ].includes(message.method)
              ? message.params
              : undefined,
          })
        } catch {
          /* Binary data is not diagnostic metadata. */
        }
      })
    })
    // Configure the real built-in account backend before starting the editor.
    // This exercises extension -> renderer -> auth worker configuration queries.
    await page.goto(new URL('account-browser-test.html', fixture.url).href)
    await page.evaluate((backendUrl) => {
      localStorage.setItem(
        'settings',
        JSON.stringify({ 'layout.backendUrl': backendUrl }),
      )
    }, new URL(fixture.url).origin)
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
    const [connections] = await Promise.all([
      page.waitForEvent('popup'),
      command('Remote Server: Manage Tunnel Access'),
    ])
    try {
      await expect(connections).toHaveURL(
        new URL('/cloudflare', fixture.url).href,
      )
      await expect(connections).toHaveTitle('Configured account connections')
    } finally {
      await connections.close()
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
    await expect.poll(() => socketPaths).toContain('/websocket/shared-process')
    await verifyDirectoryCache(page, fixture, diagnostics)
    const openRemoteFolder = async (path, expectedFile) => {
      const previousWaiterCount = remoteCliWaiterCount
      const url = await page.evaluate(async () => {
        const { executeCommand } = await import(
          document.querySelector('script[type="module"][src]').src
        )
        return executeCommand(
          'ExtensionHost.executeCommand',
          'remote-server.getWebSocketUrl',
          'shared-process',
        )
      })
      const socket = new WebSocket(url, {
        origin: new URL(fixture.url).origin,
        rejectUnauthorized: false,
      })
      await new Promise((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      try {
        const response = new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Remote CLI request timed out')),
            10_000,
          )
          socket.on('message', (data) => {
            if (String(data) === 'ready') return
            const message = JSON.parse(String(data))
            if (message.id !== 1) return
            clearTimeout(timeout)
            if (message.error) reject(new Error(message.error.message))
            else resolve(message.result)
          })
        })
        socket.send(
          JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: 'RemoteCli.open',
            params: [{ kind: 'folder', path, type: 'open' }],
          }),
        )
        if (!(await response))
          throw new Error('Remote CLI request was rejected')
      } finally {
        socket.close()
      }
      await expect(
        page.locator(
          `.TreeItem[aria-label="${expectedFile || `opened-by-cli-${cliFolders.indexOf(path) + 1}.txt`}"]`,
        ),
      ).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(() => remoteCliWaiterCount)
        .toBeGreaterThan(previousWaiterCount)
    }
    await openRemoteFolder(cliFolders[0])
    await openRemoteFolder(cliFolders[1])
    await openRemoteFolder(cliFolders[0])
    const originalWorkspace = new URL(
      `remote-server://${new URL(fixture.gateway.pairingUrl).host}`,
    )
    originalWorkspace.pathname = fixture.workspace
    await page.evaluate(async (uri) => {
      const { executeCommand } = await import(
        document.querySelector('script[type="module"][src]').src
      )
      const connection = await executeCommand(
        'ExtensionHost.executeCommand',
        'remote-server.prepareWorkspace',
        uri,
        false,
      )
      await executeCommand('Workspace.setUri', uri, '/', connection)
    }, originalWorkspace.href)
    await expect(file).toBeVisible({ timeout: 30_000 })
    await verifyAccountBrowser(context, contextOptions)
    await command('Remote Server: Benchmark Connection')
    await expect(page.locator('.Editor')).toContainText('"roundTripMs"', {
      timeout: 15_000,
    })
    await expect(page.locator('.Editor')).toContainText('"schemaVersion": 1')
    await expect(page.locator('.Editor')).toContainText('"interrupted": false')

    if (process.env.LVCE_REMOTE_WEB_REQUIRE_WORKSPACE_RESTORE === '1') {
      const expected = new URL(
        `remote-server://${new URL(fixture.gateway.pairingUrl).host}`,
      )
      expected.pathname = fixture.workspace
      expect(
        new URLSearchParams(new URL(page.url()).hash.slice(1)).get('workspace'),
      ).toBe(expected.href)
    }
    const ticketRoute = '**/auth/websocket-ticket?process=search-process'
    await page.route(ticketRoute, (route) => {
      const url = route.request().url()
      expectedSearchFailures.set(
        url,
        (expectedSearchFailures.get(url) || 0) + 1,
      )
      return route.fulfill({
        status: 503,
        body: 'Search temporarily unavailable',
      })
    })
    await page.keyboard.press('Control+p')
    const quickOpen = page.locator('.QuickPick input')
    await expect(quickOpen).toBeVisible()
    const searchError = page.locator('.Notification').filter({
      hasText: 'Could not search workspace files:',
    })
    await expect(searchError).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.QuickPick')).toHaveCount(0)
    await page.keyboard.press('Control+Shift+E')
    await expect(
      page.getByRole('tab', { name: 'Explorer', exact: true }),
    ).toHaveAttribute('aria-selected', 'true')
    await searchError.getByRole('button').last().click()
    await expect(searchError).toHaveCount(0)
    await page.unroute(ticketRoute)
    for (const [query, filename, content] of [
      ['hello', 'hello.txt', 'Hello from the remote machine'],
      ['example', 'example.ts', 'const count: number = 1'],
      ['hello', 'hello.txt', 'Hello from the remote machine'],
    ]) {
      await page.keyboard.press('Control+p')
      await expect(quickOpen).toBeVisible()
      await quickOpen.fill(query)
      await expect(page.locator('.QuickPick')).toContainText(filename)
      await page.keyboard.press('Enter')
      await expect(page.locator('.QuickPick')).toHaveCount(0)
      await expect(page.locator('.Editor')).toContainText(content)
      await expect(page.locator('.EditorInput textarea')).toBeFocused()
    }
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
      "pwd; printf 'created remotely\\n' > terminal-created.txt; printf 'REMOTE_%s_OK\\n' BROWSER; printf 'SHELL_PID_%s_END\\n' \"$$\"",
      {
        delay: 15,
      },
    )
    await page.keyboard.press('Enter')
    await expect(terminal).toContainText('REMOTE_BROWSER_OK', {
      timeout: 30_000,
    })
    await expect(terminal).toContainText(/SHELL_PID_\d+_END/)
    const shellPid = Number(
      (await terminal.textContent()).match(/SHELL_PID_(\d+)_END/)[1],
    )
    expect(
      await readFile(join(fixture.workspace, 'terminal-created.txt'), 'utf8'),
    ).toContain('created remotely')
    await expect(terminal).toContainText(fixture.workspace)
    expect(socketPaths).toContain('/websocket/terminal-process')
    await verifyHttpPreview(page, fixture, terminalInput, terminal)
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
    await page.keyboard.press('Control+Shift+E')
    await expect(
      page.getByRole('tab', { name: 'Explorer', exact: true }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(file).toBeVisible({ timeout: 30_000 })
    // Reload must reuse the valid session instead of consuming the one-time pairing URL again.
    let unexpectedPairing = false
    await page.route('**/auth/pair', (route) => {
      unexpectedPairing = true
      return route.abort('failed')
    })
    const workspaceUrl = page.url()
    await page.reload()
    await expect(
      page.getByRole('tab', { name: 'Explorer', exact: true }),
    ).toBeVisible({ timeout: 30_000 })
    if (new URL(workspaceUrl).hash.startsWith('#workspace=')) {
      expect(page.url()).toBe(workspaceUrl)
      await expect(file).toBeVisible({ timeout: 30_000 })
      await page.getByRole('menuitem', { name: 'View', exact: true }).click()
      await page
        .getByRole('menuitem', { name: 'Terminal', exact: true })
        .click()
      const reloadedTerminal = page.locator('.XtermTerminal')
      await expect(reloadedTerminal).toBeVisible({ timeout: 30_000 })
      await reloadedTerminal.click()
      await reloadedTerminal
        .locator('.xterm-helper-textarea')
        .pressSequentially(
          "pwd; printf 'reloaded remotely\\n' > reload-terminal-created.txt; printf 'RELOAD_OK\\n'\n",
        )
      await expect(reloadedTerminal).toContainText('RELOAD_OK')
      await expect(reloadedTerminal).toContainText(fixture.workspace)
      expect(
        await readFile(
          join(fixture.workspace, 'reload-terminal-created.txt'),
          'utf8',
        ),
      ).toContain('reloaded remotely')
      await page.keyboard.press('Control+Shift+E')
      await expect(
        page.getByRole('tab', { name: 'Explorer', exact: true }),
      ).toHaveAttribute('aria-selected', 'true')
      await expect(
        page.locator('.TreeItem[aria-label="reload-terminal-created.txt"]'),
      ).toBeVisible({ timeout: 30_000 })
    }
    const rendererEntry = await page
      .locator('script[type="module"][src]')
      .getAttribute('src')
    const recent = await page.evaluate(async (entry) => {
      const { executeCommand } = await import(entry)
      const recent = await executeCommand('RecentlyOpened.getRecentlyOpened')
      await executeCommand('QuickPick.showRecent')
      return recent
    }, rendererEntry)
    const remoteWorkspace = new URL(
      `remote-server://${new URL(fixture.gateway.pairingUrl).host}`,
    )
    remoteWorkspace.pathname = fixture.workspace
    expect(recent).toContain(remoteWorkspace.href)
    expect(
      recent.every(
        (uri) => !uri.includes('token=') && !uri.includes('ticket='),
      ),
    ).toBe(true)
    if (new URL(workspaceUrl).hash.startsWith('#workspace=')) {
      // Updated Pages frontends route Open Recent through prepareWorkspace.
      await page
        .getByRole('option')
        .filter({ hasText: 'workspace' })
        .first()
        .click()
      await expect(page.locator('.QuickPick')).toHaveCount(0)
    } else {
      // Older exported frontends predate that routing; exercise its connector contract directly.
      await page.keyboard.press('Escape')
      await page.evaluate(
        async ({ entry, uri }) => {
          const { executeCommand } = await import(entry)
          const connection = await executeCommand(
            'ExtensionHost.executeCommand',
            'remote-server.prepareWorkspace',
            uri,
            false,
          )
          if (!connection)
            throw new Error('Saved remote session was not restored')
          await executeCommand('Workspace.setUri', uri, '/', connection)
        },
        { entry: rendererEntry, uri: remoteWorkspace.href },
      )
    }
    await page.keyboard.press('Control+Shift+E')
    await expect(
      page.getByRole('tab', { name: 'Explorer', exact: true }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(file).toBeVisible({ timeout: 30_000 })
    await file.dblclick()
    await expect(page.locator('.Editor')).toContainText(
      'Saved from the browser',
    )
    expect(unexpectedPairing).toBe(false)
    await page.unroute('**/auth/pair')
    await page.keyboard.press('Control+Shift+G')
    await expect(page.locator('.SourceControl')).toContainText('hello.txt', {
      timeout: 30_000,
    })
    expect(socketPaths).toContain('/websocket/extension-node-process')
    let languagePid
    if (fixture.injectedLanguage) {
      await command('Remote Language Test: Validate TypeScript')
      await expect(page.locator('.NotificationMessage').last()).toContainText(
        '2322:',
        { timeout: 30_000 },
      )
      languagePid = Number(
        (await page.locator('.NotificationMessage').last().textContent()).match(
          /pid (\d+)/,
        )[1],
      )
    }
    expect(diagnostics.filter((item) => typeof item === 'string')).toEqual([])
    await page.locator('.Editor').click()
    await page.evaluate(async (entry) => {
      const { executeCommand } = await import(entry)
      await executeCommand('Main.focus')
    }, rendererEntry)
    await page.locator('.EditorInput textarea').focus()
    await expect(page.locator('.EditorInput textarea')).toBeFocused()
    await page.keyboard.type('Unsaved text must survive disconnect')
    const getBufferText = () =>
      page.evaluate(async (entry) => {
        const { executeCommand } = await import(entry)
        return (
          (await executeCommand('GetActiveEditor.getTextDocument'))?.text || ''
        )
      }, rendererEntry)
    await expect
      .poll(getBufferText)
      .toContain('Unsaved text must survive disconnect')
    const revocation = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/auth/revoke' &&
        response.request().method() === 'POST',
    )
    await command('Remote Server: Disconnect')
    await revocation
    await expect(page.locator('.QuickPick')).toHaveCount(0)
    await expect
      .poll(getBufferText)
      .toContain('Unsaved text must survive disconnect')
    for (const pid of [shellPid, languagePid].filter(Boolean)) {
      await expect
        .poll(
          () => {
            try {
              process.kill(pid, 0)
              return true
            } catch {
              return false
            }
          },
          { timeout: 10000 },
        )
        .toBe(false)
    }
    await command('Remote Server: Connection Status')
    await expect(page.locator('.NotificationMessage').last()).toContainText(
      'Disconnected',
    )
    await page.close()
    page = await context.newPage()
    await page.route('**/auth/pair', (route) =>
      route.abort('connectionrefused'),
    )
    await page.goto(fixture.url)
    await expect(
      page.getByRole('tab', { name: 'Explorer', exact: true }),
    ).toBeVisible({ timeout: 30_000 })
    await command('Remote Server: Connect with Pairing URL')
    await expect(page.locator('.QuickPick input')).toHaveAttribute(
      'placeholder',
      'Paste the HTTPS pairing URL from the remote LVCE server',
    )
    await page.locator('.QuickPick input').fill(fixture.gateway.pairingUrl)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toContainText(
      'Could not reach the remote server. Check its HTTPS certificate',
    )
    console.log(
      `PASS ${browserName}: static HTTPS frontend, cross-origin pairing, remote save, reload and Open Recent without pairing again, terminal, watching, search, Git, ${fixture.injectedLanguage ? 'TypeScript service, ' : ''}and dirty-buffer disconnect`,
    )
  } catch (error) {
    console.error(
      'Remote transport diagnostics:',
      redact(JSON.stringify(diagnostics)),
    )
    console.error('Ingress requests:', fixture.diagnostics)
    console.error('Backend:', redact(fixture.getBackendLog?.()))
    console.error(
      redact(
        await page
          ?.locator('body')
          .ariaSnapshot()
          .catch(() => 'Page snapshot unavailable'),
      ),
    )
    throw new Error(redact(error.stack || error.message))
  } finally {
    await context?.close()
    await browser?.close()
    await fixture.dispose()
  }
}
