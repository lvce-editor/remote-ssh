import { fork, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
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

const getSha256 = async (filePath) => {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex')
}

const runProcessChecked = async (command, args) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  const { promise, reject, resolve } = Promise.withResolvers()
  child.once('error', reject)
  child.once('close', (code) => {
    if (code !== 0) {
      reject(new Error(stderr.join('') || stdout.join('')))
      return
    }
    resolve()
  })
  return promise
}

const createRemoteServerArtifacts = async (runtimeRoot) => {
  const artifactsRoot = join(runtimeRoot, 'artifacts')
  const nodeRoot = join(artifactsRoot, 'node-test', 'bin')
  const nodeArchiveName = 'node-test-linux-x64.tar.gz'
  const providedNodeArchivePath = process.env.LVCE_REMOTE_SSH_TEST_NODE_ARCHIVE
  const nodeArchivePath =
    providedNodeArchivePath || join(artifactsRoot, nodeArchiveName)
  const serverArchiveName = 'lvce-remote-ssh-server-dev.tar.gz'
  const serverArchivePath = join(repositoryRoot, serverArchiveName)
  const remoteRoot = join(runtimeRoot, 'remote-server')
  const backendScript =
    process.env.LVCE_REMOTE_SSH_BACKEND_SCRIPT ||
    join(
      repositoryRoot,
      'node_modules',
      '@lvce-editor',
      'server',
      'src',
      'server.js',
    )
  if (!providedNodeArchivePath) {
    await mkdir(nodeRoot, { recursive: true })
    await cp(process.execPath, join(nodeRoot, 'node'))
    await chmod(join(nodeRoot, 'node'), 0o755)
    await runProcessChecked('tar', [
      '-czf',
      nodeArchivePath,
      '-C',
      artifactsRoot,
      'node-test',
    ])
  }
  return {
    env: {
      LVCE_REMOTE_SSH_NODE_ARCHIVE_NAME: nodeArchiveName,
      LVCE_REMOTE_SSH_NODE_ARCHIVE_SHA256: await getSha256(nodeArchivePath),
      LVCE_REMOTE_SSH_NODE_ARCHIVE_URL: pathToFileURL(nodeArchivePath).href,
      LVCE_REMOTE_SSH_NODE_VERSION: 'test-node',
      LVCE_REMOTE_SSH_REMOTE_ROOT: remoteRoot,
      LVCE_REMOTE_SSH_BACKEND_SCRIPT: backendScript,
      LVCE_REMOTE_SSH_SERVER_ARCHIVE_NAME: serverArchiveName,
      LVCE_REMOTE_SSH_SERVER_ARCHIVE_SHA256: await getSha256(serverArchivePath),
      LVCE_REMOTE_SSH_SERVER_ARCHIVE_URL: pathToFileURL(serverArchivePath).href,
      LVCE_REMOTE_SSH_SERVER_VERSION: 'dev',
    },
    remoteRoot,
  }
}

const stopRemoteServer = async (remoteRoot) => {
  if (!remoteRoot) {
    return
  }
  try {
    const state = JSON.parse(
      await readFile(join(remoteRoot, 'run', 'server-dev.json'), 'utf8'),
    )
    process.kill(state.pid, 'SIGTERM')
  } catch {
    // The remote server may not have started or may already have exited.
  }
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
  if (process.env.LVCE_REMOTE_SSH_LOCAL_LVCE_DIST) {
    return join(process.env.LVCE_REMOTE_SSH_LOCAL_LVCE_DIST, 'extensions')
  }
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
  const gitExtensionPath = join(
    repositoryRoot,
    '.tmp',
    'remote-ssh-server',
    'lvce-server',
    'extensions',
    'builtin.git',
  )
  const extensions = [
    { id: 'builtin.remote-ssh', source: extensionPath },
    { id: 'builtin.git', source: gitExtensionPath },
  ]
  const installedExtensionPaths = extensions.map(({ id }) =>
    join(builtinExtensionsPath, id),
  )
  let staticConfigContent
  let staticConfigPath
  for (const installedExtensionPath of installedExtensionPaths) {
    try {
      await access(installedExtensionPath)
      throw new Error(
        `Refusing to replace existing built-in extension: ${installedExtensionPath}`,
      )
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        throw error
      }
    }
  }
  try {
    for (const [index, { source }] of extensions.entries()) {
      await cp(source, installedExtensionPaths[index], { recursive: true })
    }

    const testExtensionPath = join(runtimeRoot, 'extension')
    await cp(extensionPath, testExtensionPath, { recursive: true })
    const manifestPath = join(testExtensionPath, 'extension.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, builtin: true }, undefined, 2)}\n`,
    )

    if (!process.env.LVCE_REMOTE_SSH_LOCAL_LVCE_DIST) {
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
          "default-src 'none'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; script-src 'self';",
        'Content-Type': 'text/javascript',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
      })
      const commitHash = basename(dirname(builtinExtensionsPath))
      for (const relativePath of [
        'builtin.remote-ssh/dist/remoteSshMain.js',
        'builtin.git/dist/gitMain.js',
        'builtin.git/git-worker/dist/gitWorkerMain.js',
      ]) {
        staticConfig.files[`/${commitHash}/extensions/${relativePath}`] =
          headerIndex
      }
      await writeFile(
        staticConfigPath,
        `${JSON.stringify(staticConfig, undefined, 2)}\n`,
      )
    }

    return {
      builtinExtensionsPath,
      installedExtensionPaths,
      staticConfigContent,
      staticConfigPath,
      testExtensionPath,
    }
  } catch (error) {
    if (staticConfigContent && staticConfigPath) {
      await writeFile(staticConfigPath, staticConfigContent)
    }
    for (const installedExtensionPath of installedExtensionPaths) {
      await rm(installedExtensionPath, { force: true, recursive: true })
    }
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
  const serverPath = process.env.LVCE_REMOTE_SSH_LOCAL_LVCE_DIST
    ? process.env.LVCE_REMOTE_SSH_LOCAL_LVCE_SERVER_PATH ||
      process.env.LVCE_REMOTE_SSH_BACKEND_SCRIPT
    : join(
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
      ...(process.env.LVCE_REMOTE_SSH_LOCAL_LVCE_DIST
        ? {
            LVCE_STATIC_ROOT: join(
              process.env.LVCE_REMOTE_SSH_LOCAL_LVCE_DIST,
              'playground',
              'static',
            ),
          }
        : {}),
      ...(onlyExtensionPath ? { ONLY_EXTENSION: onlyExtensionPath } : {}),
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
  const response = await page.goto(
    `http://localhost:${port}/tests/remote-ssh.connect.html`,
  )
  if (!response?.ok()) {
    throw new Error(`Remote SSH test page returned HTTP ${response?.status()}`)
  }
  const quickInput = page.locator('.QuickPick input')
  try {
    await expect(quickInput).toBeVisible({ timeout: 30_000 })
  } catch (error) {
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => '')
    throw new Error(
      `Remote SSH prompt did not open at ${page.url()}; page text: ${JSON.stringify(body.slice(0, 4000))}`,
      { cause: error },
    )
  }
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

  const warmFolders = Array.from(
    { length: 5 },
    (_, index) => `warm-${index + 1}`,
  )
  await Promise.all(
    warmFolders.map(async (folder, index) => {
      const folderPath = join(sshServer.fixture.workspacePath, folder)
      await mkdir(folderPath)
      await writeFile(join(folderPath, `child-${index + 1}.txt`), folder)
    }),
  )

  const runtimeParent =
    process.env.LVCE_REMOTE_SSH_TEST_RUNTIME_PARENT || tmpdir()
  const runtimeRoot = await mkdtemp(
    join(runtimeParent, 'lvce-remote-ssh-runtime-'),
  )
  let browser
  let installedExtensionPaths = []
  let lvceServer
  let remoteRoot
  let staticConfigContent
  let staticConfigPath
  try {
    const prepared = await prepareExtensions(runtimeRoot)
    const remoteArtifacts = await createRemoteServerArtifacts(runtimeRoot)
    remoteRoot = remoteArtifacts.remoteRoot
    installedExtensionPaths = prepared.installedExtensionPaths
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
        ...remoteArtifacts.env,
        BUILTIN_EXTENSIONS_PATH: prepared.builtinExtensionsPath,
        HOME: homeRoot,
        XDG_CACHE_HOME: cacheRoot,
        XDG_CONFIG_HOME: configRoot,
        XDG_DATA_HOME: dataRoot,
      },
      onlyExtensionPath: undefined,
      port,
    })
    browser = await chromium.launch({
      headless: process.argv.includes('--headless'),
    })
    const page = await browser.newPage()
    page.on('console', (message) => {
      if (message.type() === 'error') {
        console.error(
          `[browser:${message.type()}] ${message.text()} ${JSON.stringify(message.location())}`,
        )
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
    const connectionCount = sshServer.getConnectionCount()
    const remoteFolder = page.locator('.TreeItem[aria-label="folder"]')
    await remoteFolder.click()
    await expect(
      page.locator('.TreeItem[aria-label="nested.txt"]'),
    ).toBeVisible({
      timeout: 5_000,
    })
    const folderReadDurations = []
    for (const [index, folder] of warmFolders.entries()) {
      const start = performance.now()
      await page.locator(`.TreeItem[aria-label="${folder}"]`).click()
      await expect(
        page.locator(`.TreeItem[aria-label="child-${index + 1}.txt"]`),
      ).toBeVisible({ timeout: 1_000 })
      folderReadDurations.push(performance.now() - start)
    }
    const sortedDurations = folderReadDurations.toSorted((a, b) => a - b)
    const median = sortedDurations[Math.floor(sortedDurations.length / 2)]
    const p95 = sortedDurations[Math.ceil(sortedDurations.length * 0.95) - 1]
    console.log(
      `Warm remote folder expansion: median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`,
    )
    expect(median).toBeLessThanOrEqual(500)
    expect(p95).toBeLessThanOrEqual(1_000)
    expect(sshServer.getConnectionCount()).toBe(connectionCount)
    expect(sshServer.getOutput()).not.toContain('python')
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

    await page.keyboard.press('Control+Backquote')
    await page.locator('.PanelTab[name="Terminals"]').click()
    const terminal = page.locator('.XtermTerminal')
    await expect(terminal).toBeVisible({ timeout: 30_000 })
    await terminal.click()
    await page.keyboard.type('pwd; echo REMOTE_TERMINAL_SENTINEL')
    await page.keyboard.press('Enter')
    await expect(terminal).toContainText('REMOTE_TERMINAL_SENTINEL', {
      timeout: 30_000,
    })
    await expect(terminal).toContainText(sshServer.fixture.workspacePath, {
      timeout: 30_000,
    })

    await page.keyboard.press('Control+Shift+F')
    const search = page.locator('.Search')
    await expect(search).toBeVisible({ timeout: 30_000 })
    const searchInput = search.locator('textarea[name="SearchValue"]')
    await searchInput.fill('REMOTE_SEARCH_SENTINEL')
    await expect(search.locator('[role="status"]')).toHaveText(
      '1 result in 1 file',
      {
        timeout: 30_000,
      },
    )
    await expect(search).toContainText('search.txt')
    await expect(search).not.toContainText('ignored.txt')

    await page.keyboard.press('Control+Shift+G')
    const sourceControl = page.locator('.SourceControl')
    await expect(sourceControl).toBeVisible({ timeout: 30_000 })
    await expect(sourceControl).toContainText('file.txt', { timeout: 30_000 })
    await expect(
      page.getByRole('button', { exact: true, name: 'main' }),
    ).toBeVisible({ timeout: 30_000 })

    await page.keyboard.press('Control+Shift+P')
    const commandInput = page.locator('.QuickPick input')
    await expect(commandInput).toBeVisible({ timeout: 30_000 })
    await commandInput.fill('>Developer: Open Process Explorer')
    await expect(
      page.locator('.QuickPickItemLabel', {
        hasText: 'Developer: Open Process Explorer',
      }),
    ).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Enter')
    const processExplorer = page.locator('.ProcessExplorer')
    await expect(processExplorer).toBeVisible({ timeout: 30_000 })
    await expect(
      processExplorer.locator('.ProcessExplorerRow'),
    ).not.toHaveCount(0, { timeout: 30_000 })
    await expect(processExplorer).toContainText('shared-process', {
      timeout: 30_000,
    })
    await expect(processExplorer).toContainText(
      'extension-host-helper-process',
      { timeout: 30_000 },
    )
  } finally {
    await cleanup([
      async () => browser?.close(),
      async () => stopProcess(lvceServer),
      async () => stopRemoteServer(remoteRoot),
      async () => sshServer.dispose(),
      async () => {
        if (staticConfigPath && staticConfigContent) {
          await writeFile(staticConfigPath, staticConfigContent)
        }
      },
      async () => {
        for (const installedExtensionPath of installedExtensionPaths) {
          await rm(installedExtensionPath, { force: true, recursive: true })
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
  process.exit(0)
} catch (error) {
  console.error(error)
  process.exit(1)
}
