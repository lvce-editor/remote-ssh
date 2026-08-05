import { fork, spawn } from 'node:child_process'
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { createSshServer } from 'e2e-helpers'

const currentDir = dirname(fileURLToPath(import.meta.url))
const e2eRoot = join(currentDir, '..')
const repositoryRoot = join(e2eRoot, '..', '..')
const extensionPath = join(e2eRoot, '..', 'extension')
const testRunnerEntryPath = fileURLToPath(
  import.meta.resolve('@lvce-editor/test-with-playwright'),
)
const testRunnerPath = join(
  dirname(testRunnerEntryPath),
  '..',
  'bin',
  'test-with-playwright.js',
)

const sleep = async (milliseconds) => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

const getAvailablePort = async () => {
  const server = createServer()
  const { promise, reject, resolve } = Promise.withResolvers()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      reject(new Error('Failed to determine an available LVCE server port'))
      return
    }
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve(address.port)
    })
  })
  return promise
}

const stopProcess = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(5_000),
  ])
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

const runPromptTest = async () => {
  const child = spawn(
    process.execPath,
    [
      testRunnerPath,
      `--only-extension=${extensionPath}`,
      '--test-path=.',
      ...process.argv.slice(2),
    ],
    {
      cwd: e2eRoot,
      env: process.env,
      stdio: 'inherit',
    },
  )
  const { promise, reject, resolve } = Promise.withResolvers()
  child.once('error', reject)
  child.once('close', (exitCode, signal) => {
    if (signal) {
      reject(new Error(`E2E test runner exited with signal ${signal}`))
      return
    }
    resolve(exitCode || 0)
  })
  return promise
}

const getBuiltinExtensionsPath = async () => {
  const sharedProcessEntryPath = fileURLToPath(
    import.meta.resolve('@lvce-editor/shared-process'),
  )
  const modulePath = join(
    dirname(sharedProcessEntryPath),
    'src',
    'parts',
    'BuiltinExtensionsPath',
    'BuiltinExtensionsPath.js',
  )
  const module = await import(pathToFileURL(modulePath).href)
  return module.getBuiltinExtensionsPath()
}

const prepareExtensions = async (runtimeRoot) => {
  const builtinExtensionsPath = await getBuiltinExtensionsPath()
  const builtinExtensionPath = join(builtinExtensionsPath, 'builtin.remote-ssh')
  let staticConfigContent
  let staticConfigPath
  try {
    await access(builtinExtensionPath)
    throw new Error(
      `Refusing to replace existing built-in extension: ${builtinExtensionPath}`,
    )
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      throw error
    }
  }
  try {
    await cp(extensionPath, builtinExtensionPath, { recursive: true })

    const testExtensionPath = join(runtimeRoot, 'extension')
    await cp(extensionPath, testExtensionPath, { recursive: true })
    const manifestPath = join(testExtensionPath, 'extension.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, builtin: true }, undefined, 2)}\n`,
    )

    staticConfigPath = join(
      builtinExtensionsPath,
      '..',
      '..',
      '..',
      'config.json',
    )
    staticConfigContent = await readFile(staticConfigPath, 'utf8')
    const staticConfig = JSON.parse(staticConfigContent)
    const headerIndex = staticConfig.headers.length
    staticConfig.headers.push({
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; connect-src 'self'; script-src 'self';",
      'Content-Type': 'text/javascript',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    })
    const commitHash = basename(dirname(builtinExtensionsPath))
    staticConfig.files[
      `/${commitHash}/extensions/builtin.remote-ssh/dist/remoteSshMain.js`
    ] = headerIndex
    await writeFile(
      staticConfigPath,
      `${JSON.stringify(staticConfig, undefined, 2)}\n`,
    )

    return {
      builtinExtensionsPath,
      builtinExtensionPath,
      staticConfigContent,
      staticConfigPath,
      testExtensionPath,
    }
  } catch (error) {
    if (staticConfigContent && staticConfigPath) {
      await writeFile(staticConfigPath, staticConfigContent)
    }
    await rm(builtinExtensionPath, { force: true, recursive: true })
    throw error
  }
}

const cleanup = async (tasks) => {
  const errors = []
  for (const task of tasks) {
    try {
      await task()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Failed to clean up remote SSH E2E test')
  }
}

const startLvceServer = async ({ env, onlyExtensionPath, port }) => {
  const serverPath = join(
    repositoryRoot,
    'node_modules',
    '@lvce-editor',
    'server',
    'src',
    'server.js',
  )
  const child = fork(serverPath, {
    detached: true,
    env: {
      ...env,
      ONLY_EXTENSION: onlyExtensionPath,
      PORT: String(port),
      TEST_PATH: e2eRoot,
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  const { promise, reject, resolve } = Promise.withResolvers()
  const timer = setTimeout(() => {
    reject(new Error('Timed out waiting for the LVCE server to start'))
  }, 30_000)
  child.once('error', reject)
  child.once('exit', (exitCode) => {
    reject(new Error(`LVCE server exited early with code ${exitCode}`))
  })
  child.once('message', () => resolve())
  try {
    await promise
    return child
  } finally {
    clearTimeout(timer)
  }
}

const waitForSavedFile = async (filePath, expectedContent) => {
  let actualContent = ''
  for (let attempt = 0; attempt < 100; attempt++) {
    actualContent = await readFile(filePath, 'utf8')
    if (actualContent === expectedContent) {
      return
    }
    await sleep(100)
  }
  throw new Error(
    `Expected SSH-backed file content ${JSON.stringify(expectedContent)}, got ${JSON.stringify(actualContent)}`,
  )
}

const promptPlaceholder =
  'Enter SSH host (for example user@example.com or ssh -p 2222 user@example.com)'

const openPromptScenario = async (page, port) => {
  await page.goto(`http://localhost:${port}/tests/remote-ssh.connect.html`)
  const quickInput = page.locator('.QuickPick input')
  await expect(quickInput).toBeVisible({ timeout: 30_000 })
  await expect(quickInput).toHaveAttribute('placeholder', promptPlaceholder, {
    timeout: 30_000,
  })
  await expect(page.locator('#TestOverlay[data-state="pass"]')).toBeVisible({
    timeout: 30_000,
  })
  return quickInput
}

const expectConfiguredHosts = async (page, expectedHosts) => {
  await expect(page.locator('.QuickPickItemLabel')).toHaveText(expectedHosts, {
    timeout: 30_000,
  })
  await expect(page.locator('.QuickPickItemDescription')).toHaveText(
    expectedHosts.map(() => 'SSH config'),
    { timeout: 30_000 },
  )
}

const expectTextInputFallback = async (page) => {
  await expect(page.locator('.QuickPickItemLabel')).toHaveCount(0)
}

const runRealSshTest = async () => {
  const sshServer = await createSshServer()
  if (!sshServer) {
    return
  }

  const runtimeRoot = await mkdtemp(join(tmpdir(), 'lvce-remote-ssh-runtime-'))
  let browser
  let builtinExtensionPath
  let lvceServer
  let staticConfigContent
  let staticConfigPath
  try {
    const prepared = await prepareExtensions(runtimeRoot)
    builtinExtensionPath = prepared.builtinExtensionPath
    staticConfigContent = prepared.staticConfigContent
    staticConfigPath = prepared.staticConfigPath
    const configRoot = join(runtimeRoot, 'config')
    const cacheRoot = join(runtimeRoot, 'cache')
    const dataRoot = join(runtimeRoot, 'data')
    const homeRoot = join(runtimeRoot, 'home')
    const sshRoot = join(homeRoot, '.ssh')
    const sshConfigPath = join(sshRoot, 'config')
    await Promise.all([
      mkdir(configRoot),
      mkdir(cacheRoot),
      mkdir(dataRoot),
      mkdir(sshRoot, { recursive: true }),
    ])
    await writeFile(
      sshConfigPath,
      [
        'Host work staging',
        '  HostName example.com',
        'Host *.internal !blocked wildcard-safe',
        '  HostName internal.example.com',
        'Host WORK',
        '',
      ].join('\n'),
    )
    const port = await getAvailablePort()
    lvceServer = await startLvceServer({
      env: {
        ...sshServer.env,
        BUILTIN_EXTENSIONS_PATH: prepared.builtinExtensionsPath,
        HOME: homeRoot,
        XDG_CACHE_HOME: cacheRoot,
        XDG_CONFIG_HOME: configRoot,
        XDG_DATA_HOME: dataRoot,
      },
      onlyExtensionPath: prepared.testExtensionPath,
      port,
    })
    browser = await chromium.launch({
      headless: process.argv.includes('--headless'),
    })
    const page = await browser.newPage()
    page.on('console', (message) => {
      if (message.type() === 'error') {
        console.error(`[browser] ${message.text()}`)
      }
    })
    page.on('pageerror', (error) => {
      console.error(`[browser] ${error}`)
    })
    await openPromptScenario(page, port)
    await expectConfiguredHosts(page, ['work', 'staging', 'wildcard-safe'])

    await writeFile(sshConfigPath, 'Host "unterminated\n')
    await openPromptScenario(page, port)
    await expectTextInputFallback(page)

    await writeFile(sshConfigPath, 'Host *\nHost *.example.com\n')
    await openPromptScenario(page, port)
    await expectTextInputFallback(page)

    await writeFile(sshConfigPath, '')
    await openPromptScenario(page, port)
    await expectTextInputFallback(page)

    await writeFile(sshConfigPath, 'Host unreadable\n')
    await chmod(sshConfigPath, 0o000)
    await openPromptScenario(page, port)
    await expectTextInputFallback(page)
    await chmod(sshConfigPath, 0o600)

    await rm(sshConfigPath)
    await openPromptScenario(page, port)
    await expectTextInputFallback(page)

    await writeFile(sshConfigPath, 'Host work staging\n')
    const quickInput = await openPromptScenario(page, port)
    await expectConfiguredHosts(page, ['work', 'staging'])
    await quickInput.fill(sshServer.fixture.target)
    await page.keyboard.press('Enter')

    const remoteFile = page.locator('.TreeItem[aria-label="file.txt"]')
    await expect(remoteFile).toBeVisible({ timeout: 30_000 })
    await remoteFile.click()
    const editor = page.locator('.Editor')
    await expect(editor).toContainText(sshServer.fixture.initialContent, {
      timeout: 30_000,
    })
    const editorInput = page.locator('.EditorInput textarea')
    await expect(editorInput).toBeVisible({ timeout: 30_000 })
    await editorInput.focus()
    await expect(editorInput).toBeFocused()
    await editorInput.press('Control+End')
    await page.keyboard.type(
      sshServer.fixture.updatedContent.slice(
        sshServer.fixture.initialContent.length,
      ),
    )
    await expect(editor).toContainText(sshServer.fixture.updatedContent, {
      timeout: 30_000,
    })
    await page.keyboard.press('Control+S')

    await waitForSavedFile(sshServer.filePath, sshServer.fixture.updatedContent)
  } finally {
    await cleanup([
      async () => browser?.close(),
      async () => stopProcess(lvceServer),
      async () => sshServer.dispose(),
      async () => {
        if (staticConfigPath && staticConfigContent) {
          await writeFile(staticConfigPath, staticConfigContent)
        }
      },
      async () => {
        if (builtinExtensionPath) {
          await rm(builtinExtensionPath, { force: true, recursive: true })
        }
      },
      async () => rm(runtimeRoot, { force: true, recursive: true }),
    ])
  }
}

const main = async () => {
  if (process.platform === 'linux') {
    await runRealSshTest()
    return
  }
  const exitCode = await runPromptTest()
  if (exitCode !== 0) {
    process.exitCode = exitCode
  }
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
