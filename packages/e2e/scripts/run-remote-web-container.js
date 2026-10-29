import { execFile } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
  cp,
} from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium, expect } from '@playwright/test'
import { createFixture } from './remote-web-fixture.js'

const execute = promisify(execFile)
const fixture = await createFixture({ containers: true })
let browser
let containerId
try {
  await mkdir(join(fixture.workspace, '.devcontainer'))
  await writeFile(
    join(fixture.workspace, '.devcontainer', 'devcontainer.json'),
    JSON.stringify({
      image: 'mcr.microsoft.com/devcontainers/base:ubuntu24.04',
      workspaceFolder: '/container-workspace',
      workspaceMount: `source=${fixture.workspace},target=/container-workspace,type=bind`,
      remoteUser: 'root',
      postCreateCommand:
        'echo container-only > /container-marker; echo inside > container-only.txt; mkdir -p /root/.local/share/lvce-oss/extensions; cp -r /container-workspace/.probe-extension /root/.local/share/lvce-oss/extensions/e2e.remote-language',
    }),
  )
  browser = await chromium.launch({
    headless: true,
    args: process.env.LVCE_CONTAINER_DEBUG
      ? ['--remote-debugging-port=39239']
      : [],
  })
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ['local-network-access'],
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  if (process.env.LVCE_CONTAINER_DEBUG) {
    page.on('console', (message) => {
      if (message.type() === 'error')
        console.log('browser-error', message.text())
    })
    page.on('websocket', (socket) => {
      socket.on('framesent', ({ payload }) => {
        try {
          const data = JSON.parse(String(payload))
          console.log(
            'sent',
            new URL(socket.url()).pathname,
            data.method,
            data.id,
          )
        } catch {}
      })
      socket.on('framereceived', ({ payload }) => {
        try {
          const data = JSON.parse(String(payload))
          console.log(
            'received',
            new URL(socket.url()).pathname,
            data.method,
            data.id,
            data.error,
          )
        } catch {}
      })
    })
  }

  await page.goto(fixture.url)
  await expect(
    page.getByRole('tab', { name: 'Explorer', exact: true }),
  ).toBeVisible({ timeout: 30000 })
  const command = async (label, opensInput = false) => {
    await page.keyboard.press('Control+Shift+P')
    const input = page.locator('.QuickPick input')
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('>')
    await input.fill(`>${label}`)
    await expect(
      page.getByRole('option', { name: label, exact: true }),
    ).toBeVisible()
    await page.keyboard.press('Enter')
    if (!opensInput) await expect(page.locator('.QuickPick')).toHaveCount(0)
  }
  const executeCommand = async (...args) =>
    page.evaluate(async (args) => {
      const { executeCommand } = await import(
        document.querySelector('script[type="module"][src]').src
      )
      return executeCommand(...args)
    }, args)
  await command('Remote Server: Connect with Pairing URL', true)
  const input = page.locator('.QuickPick input')
  await expect(input).toHaveAttribute(
    'placeholder',
    'Paste the HTTPS pairing URL from the remote LVCE server',
  )
  await input.fill(fixture.gateway.pairingUrl)
  await page.keyboard.press('Enter')
  await expect(page.locator('.TreeItem[aria-label="hello.txt"]')).toBeVisible({
    timeout: 30000,
  })
  await command('Dev Containers: Reopen in Container')
  await expect
    .poll(() => executeCommand('Workspace.getUri'), { timeout: 120000 })
    .toContain('.lvce-container.invalid')
  await expect(
    page.locator('.TreeItem[aria-label="container-only.txt"]'),
  ).toBeVisible({ timeout: 30000 })
  const uri = await executeCommand('Workspace.getUri')
  expect(uri).toContain('.lvce-container.invalid')
  // Browser filesystem and extension execution must reach the container, not host paths.
  const marker = await executeCommand(
    'FileSystem.readFile',
    `${uri}/container-only.txt`,
  )
  expect(marker).toBe('inside\n')
  await page.keyboard.press('Control+p')
  const quickOpen = page.locator('.QuickPick input')
  await expect(quickOpen).toBeVisible()
  await quickOpen.fill('container-only')
  await expect(page.locator('.QuickPick')).toContainText('container-only.txt')
  await page.keyboard.press('Enter')
  await expect(page.locator('.Editor')).toContainText('inside')
  await page.locator('.EditorInput textarea').focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('Saved inside the container')
  await page.keyboard.press('Control+s')
  await expect(async () =>
    expect(
      await readFile(join(fixture.workspace, 'container-only.txt'), 'utf8'),
    ).toContain('Saved inside the container'),
  ).toPass()

  await executeCommand(
    'FileSystem.writeFile',
    `${uri}/edited.txt`,
    'edited through the tunnel',
  )
  expect(await readFile(join(fixture.workspace, 'edited.txt'), 'utf8')).toBe(
    'edited through the tunnel',
  )
  expect(
    await executeCommand(
      'ExtensionHost.executeCommand',
      'e2e.remote-language.probe',
      uri,
    ),
  ).toEqual({
    marker: 'container-only\n',
    cwd: '/container-workspace',
    workspace: uri,
  })
  await executeCommand('Layout.showPanel', 'Terminals')
  await executeCommand('Terminals.addTerminal')
  const terminal = page.locator('.XtermTerminal')
  await expect(terminal).toBeVisible({ timeout: 30000 })
  await terminal.click()
  const terminalInput = terminal.locator('.xterm-helper-textarea')
  await expect(terminalInput).toBeFocused()
  await terminalInput.pressSequentially('cat /container-marker; pwd', {
    delay: 15,
  })
  await page.keyboard.press('Enter')
  await expect(terminal).toContainText('container-only', { timeout: 30000 })
  await expect(terminal).toContainText('/container-workspace')
  if (process.env.LVCE_CONTAINER_SCREENSHOT)
    await page.screenshot({ path: process.env.LVCE_CONTAINER_SCREENSHOT })
  await page.reload()
  await expect(
    page.locator('.TreeItem[aria-label="container-only.txt"]'),
  ).toBeVisible({ timeout: 30000 })
  expect(await executeCommand('Workspace.getUri')).toBe(uri)
  await command('Dev Containers: Reopen in Container')
  expect(await executeCommand('Workspace.getUri')).toBe(uri)
  await command('Dev Containers: Reopen on Remote Host')
  await expect
    .poll(() => executeCommand('Workspace.getUri'))
    .not.toContain('.lvce-container.invalid')
  await expect(page.locator('.TreeItem[aria-label="hello.txt"]')).toBeVisible()
  const { stdout } = await execute('docker', [
    'ps',
    '-q',
    '--filter',
    `label=devcontainer.local_folder=${fixture.workspace}`,
  ])
  containerId = stdout.trim()
  expect(errors).toEqual([])
  console.log(
    'Container browser acceptance passed: reopen, file search, UI editing/save, filesystem write, Node extension, terminal, reload, repeated reopen, return to host',
  )
} finally {
  await browser?.close()
  await fixture.dispose()
  if (!containerId) {
    const { stdout } = await execute('docker', [
      'ps',
      '-aq',
      '--filter',
      `label=devcontainer.local_folder=${fixture.workspace}`,
    ])
    containerId = stdout.trim()
  }
  if (containerId) await execute('docker', ['rm', '-f', containerId])
}
