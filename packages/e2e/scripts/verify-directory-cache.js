import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect } from '@playwright/test'

export const verifyDirectoryCache = async (page, fixture, diagnostics) => {
  const directory = join(fixture.workspace, 'cache-directory')
  const backendUri = pathToFileURL(directory).href
  const remoteUri = new URL(
    `remote-server://${new URL(fixture.gateway.pairingUrl).host}`,
  )
  remoteUri.pathname = directory
  const execute = (method, ...args) =>
    page.evaluate(
      async ({ method, args }) => {
        const { executeCommand } = await import(
          document.querySelector('script[type="module"][src]').src
        )
        return executeCommand(method, ...args)
      },
      { method, args },
    )
  const count = (method) =>
    diagnostics.filter(
      (event) =>
        event.process === '/websocket/file-system-process' &&
        event.method === method &&
        event.params?.[0] === backendUri,
    ).length

  // Recent directory timestamps deliberately disable caching. Wait on the real
  // optional capability rather than using a timing delay or bypassing its guard.
  await expect
    .poll(() => execute('FileSystem.getDirectoryVersion', remoteUri.href))
    .toBeTruthy()
  const folder = page.locator('.TreeItem[aria-label="cache-directory"]')
  const first = page.locator('.TreeItem[aria-label="cached-first.txt"]')
  await folder.click()
  await expect(folder).toHaveAttribute('aria-expanded', 'true')
  await expect(first).toBeVisible()
  const listings = count('FileSystem.readDirWithFileTypes')
  const validations = count('FileSystem.getDirectoryVersion')
  expect(listings).toBeGreaterThan(0)
  await page.keyboard.press('ArrowLeft')
  await expect(folder).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('ArrowRight')
  await expect(first).toBeVisible()
  expect(count('FileSystem.readDirWithFileTypes')).toBe(listings)
  expect(count('FileSystem.getDirectoryVersion')).toBeGreaterThan(validations)

  // Recreate the workspace view while preserving the remote provider session.
  const workspaceUri = await execute('Workspace.getUri')
  const connection = await execute(
    'ExtensionHost.executeCommand',
    'remote-server.prepareWorkspace',
    workspaceUri,
    false,
  )
  await execute('Workspace.setUri', remoteUri.href, '/', connection)
  await expect(first).toBeVisible()
  await execute('Workspace.setUri', workspaceUri, '/', connection)
  await expect(folder).toBeVisible()
  if ((await folder.getAttribute('aria-expanded')) !== 'true') {
    await folder.click()
  }
  await expect(first).toBeVisible()
  expect(count('FileSystem.readDirWithFileTypes')).toBe(listings)
  expect(count('FileSystem.getDirectoryVersion')).toBeGreaterThan(validations)

  // Filesystem changes bypass renderer mutation invalidation and must still
  // appear after the cached folder is refreshed by the real remote watcher.
  await writeFile(join(directory, 'cached-created.txt'), 'external create')
  const created = page.locator('.TreeItem[aria-label="cached-created.txt"]')
  await expect(created).toBeVisible({ timeout: 30_000 })
  await rename(
    join(directory, 'cached-created.txt'),
    join(directory, 'cached-renamed.txt'),
  )
  await expect(created).toBeHidden({ timeout: 30_000 })
  const renamed = page.locator('.TreeItem[aria-label="cached-renamed.txt"]')
  await expect(renamed).toBeVisible()
  await rm(join(directory, 'cached-renamed.txt'))
  await expect(renamed).toBeHidden({ timeout: 30_000 })
  const beforeRefresh = count('FileSystem.readDirWithFileTypes')
  await execute('Explorer.refresh')
  await expect
    .poll(() => count('FileSystem.readDirWithFileTypes'))
    .toBeGreaterThan(beforeRefresh)
}
