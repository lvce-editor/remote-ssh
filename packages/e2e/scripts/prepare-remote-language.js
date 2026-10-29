import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleJs } from '../../build/src/bundleJs.ts'

export const prepareLanguage = async (
  repository,
  directory,
  workspace,
  container = false,
) => {
  const directoryPath = join(directory, 'language-extension')
  await mkdir(directoryPath)
  const manifest = {
    id: 'e2e.remote-language',
    name: 'Remote TypeScript test service',
    browser: 'browser.js',
    isolated: true,
    compatibility: { web: false },
    contentSecurityPolicy: ["default-src 'none'", "script-src 'self'"],
    rpc: [
      {
        id: 'e2e.remote-language.compiler',
        type: 'node-process',
        url: 'server.mjs',
        onRemote: 'runOnRemote',
      },
    ],
    activation: ['onCommand:e2e.remote-language.validate'],
    commands: [
      {
        id: 'e2e.remote-language.validate',
        label: 'Remote Language Test: Validate TypeScript',
      },
    ],
  }
  if (container) {
    manifest.compatibility.web = true
    manifest.activation.push('onCommand:e2e.remote-language.probe')
    manifest.commands.push({ id: 'e2e.remote-language.probe', internal: true })
  }
  await writeFile(
    join(directoryPath, 'extension.json'),
    JSON.stringify(manifest),
  )
  await writeFile(
    join(workspace, 'invalid.ts'),
    'const remoteCount: number = "invalid"\n',
  )
  const file = new URL('file:///')
  file.pathname = join(workspace, 'invalid.ts')
  await bundleJs({
    input: join(repository, 'packages/e2e/fixtures/remote-language/browser.js'),
    outfile: join(directoryPath, 'browser.js'),
    platform: 'browser',
    define: { __LVCE_REMOTE_LANGUAGE_FILE__: JSON.stringify(file.href) },
  })
  await bundleJs({
    input: join(repository, 'packages/e2e/fixtures/remote-language/server.js'),
    outfile: join(directoryPath, 'server.mjs'),
    platform: 'node',
    define: {
      __LVCE_REMOTE_TYPESCRIPT_MODULE__: JSON.stringify(
        fileURLToPath(import.meta.resolve('typescript')),
      ),
    },
  })
  if (container) {
    await bundleJs({
      input: join(
        repository,
        'packages/e2e/fixtures/remote-language/container-browser.js',
      ),
      outfile: join(directoryPath, 'browser.js'),
      platform: 'browser',
    })
    await bundleJs({
      input: join(
        repository,
        'packages/e2e/fixtures/remote-language/container-server.js',
      ),
      outfile: join(directoryPath, 'server.mjs'),
      platform: 'node',
    })
  }
  const installedExtensions = join(directory, 'data', 'lvce-oss', 'extensions')
  await mkdir(installedExtensions, { recursive: true })
  await cp(directoryPath, join(installedExtensions, manifest.id), {
    recursive: true,
  })
  return { directoryPath, manifest }
}
