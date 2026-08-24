import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { createSshServer } from 'e2e-helpers'
import { createIwaServer } from './serve.js'

const listen = (server) => {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to determine the IWA server port'))
        return
      }
      resolve(address.port)
    })
  })
}

const close = (server) => {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

const parseTarget = (target) => {
  const match = /^ssh -p (\d+) ([^@]+)@([^:]+):/.exec(target)
  if (!match) {
    throw new Error(`Unexpected SSH fixture target: ${target}`)
  }
  return {
    host: match[3],
    port: match[1],
    user: match[2],
  }
}

const staticServer = createIwaServer()
const sshServer = await createSshServer()
if (!sshServer) {
  throw new Error('The IWA SSH e2e test requires Linux')
}

let context
try {
  const staticPort = await listen(staticServer)
  const proxyUrl = `http://localhost:${staticPort}/`
  const profilePath = join(dirname(dirname(sshServer.filePath)), 'chrome')
  const preferencesPath = join(profilePath, 'Default', 'Preferences')
  // Headless Chromium cannot accept the native local-network permission
  // prompt, so grant it only in this disposable e2e profile.
  await mkdir(dirname(preferencesPath), { recursive: true })
  await writeFile(
    preferencesPath,
    JSON.stringify({
      profile: {
        default_content_setting_values: {
          has_migrated_local_network_access: true,
          local_network: 1,
          loopback_network: 1,
        },
      },
    }),
  )
  context = await chromium.launchPersistentContext(profilePath, {
    args: [
      '--enable-features=IsolatedWebApps,IsolatedWebAppDevMode',
      '--no-sandbox',
    ],
    executablePath: chromium.executablePath(),
    headless: true,
  })

  const internalsPage = await context.newPage()
  await internalsPage.goto('chrome://web-app-internals')
  const proxyInput = internalsPage.locator(
    'input[placeholder="http://localhost:8000/"]',
  )
  await proxyInput.click()
  await proxyInput.press('Control+A')
  await proxyInput.pressSequentially(proxyUrl)
  await proxyInput.press('Tab')
  const installButton = internalsPage.getByRole('button', {
    exact: true,
    name: 'Install',
  })
  await expect(installButton).toBeEnabled()
  await installButton.click()
  await expect(internalsPage.locator('body')).toContainText(
    `Installing IWA: ${proxyUrl} successfully installed.`,
  )

  const appsPage = await context.newPage()
  await appsPage.goto('chrome://apps')
  const appPagePromise = context.waitForEvent('page')
  await appsPage
    .getByRole('button', { name: 'LVCE Remote SSH Experiment' })
    .click()
  const appPage = await appPagePromise
  await appPage.waitForLoadState('domcontentloaded')
  await expect(appPage.locator('#capability')).toContainText(
    'Direct Sockets are available',
  )
  const target = parseTarget(sshServer.fixture.target)
  const privateKeyPath = join(
    dirname(dirname(sshServer.filePath)),
    'id_ed25519',
  )
  await appPage.getByLabel('Host').fill(target.host)
  await appPage.getByLabel('Port').fill(target.port)
  await appPage.getByLabel('User').fill(target.user)
  await appPage.getByText('Use a private key instead').click()
  await appPage.getByLabel('Private key file').setInputFiles(privateKeyPath)
  await appPage.getByRole('button', { exact: true, name: 'Connect' }).click()
  const connectionStatus = appPage.locator('#status')
  await expect(connectionStatus).not.toHaveText('connecting', {
    timeout: 30_000,
  })
  if ((await connectionStatus.textContent()) !== 'connected') {
    throw new Error(
      `Browser-only SSH connection failed: ${await appPage.locator('#terminal').textContent()}`,
    )
  }

  await appPage
    .getByLabel('Command')
    .fill('printf "$LVCE_REMOTE_SSH_E2E_MARKER\\n"')
  await appPage.getByRole('button', { exact: true, name: 'Send' }).click()
  await expect(appPage.locator('#terminal')).toContainText(
    sshServer.fixture.remoteTerminalMarker,
    { timeout: 30_000 },
  )
  await appPage.getByRole('button', { exact: true, name: 'Disconnect' }).click()
  await expect(appPage.locator('#status')).toHaveText('disconnected')
} finally {
  await context?.close()
  await sshServer.dispose()
  await close(staticServer)
}
