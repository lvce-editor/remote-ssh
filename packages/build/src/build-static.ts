import { cp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { root } from './root.ts'

interface ExtensionManifest {
  readonly id: string
  readonly [key: string]: unknown
}

interface SharedProcess {
  readonly exportStatic: (options: {
    readonly extensionPath: string
    readonly root: string
    readonly testPath: string
  }) => Promise<{ readonly commitHash: string }>
}

const readJson = async <T>(file: string): Promise<T> =>
  JSON.parse(await readFile(file, 'utf8')) as T

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

await import('./build.ts')

const sharedProcessUrl = import.meta.resolve('@lvce-editor/shared-process')
const { exportStatic } = (await import(sharedProcessUrl)) as SharedProcess

await cp(path.join(root, 'dist'), path.join(root, 'dist2'), {
  force: true,
  recursive: true,
})
await cp(path.join(root, 'dist-web'), path.join(root, 'dist-web2'), {
  force: true,
  recursive: true,
})

const { commitHash } = await exportStatic({
  extensionPath: 'packages/extension',
  root,
  testPath: 'packages/e2e',
})

await cp(
  path.join(root, 'dist2'),
  path.join(root, 'dist', commitHash, 'extensions', 'builtin.remote-ssh'),
  {
    force: true,
    recursive: true,
  },
)

await cp(
  path.join(root, 'dist-web2'),
  path.join(root, 'dist', commitHash, 'extensions', 'builtin.remote-server'),
  {
    force: true,
    recursive: true,
  },
)

const configDirectory = path.join(root, 'dist', commitHash, 'config')
const webExtensionManifest = await readJson<ExtensionManifest>(
  path.join(root, 'packages', 'web-extension', 'extension.json'),
)
const webExtensionPath = `${process.env.PATH_PREFIX || ''}/${commitHash}/extensions/${webExtensionManifest.id}`
const extensionsFile = path.join(configDirectory, 'extensions.json')
const extensions = await readJson<ExtensionManifest[]>(extensionsFile)
await writeJson(extensionsFile, [
  ...extensions.filter(({ id }) => id !== webExtensionManifest.id),
  { ...webExtensionManifest, path: webExtensionPath },
])

const webExtensionsFile = path.join(configDirectory, 'webExtensions.json')
const webExtensions = await readJson<ExtensionManifest[]>(webExtensionsFile)
await writeJson(webExtensionsFile, [
  ...webExtensions.filter(({ id }) => id !== webExtensionManifest.id),
  { ...webExtensionManifest, isWeb: true, path: webExtensionPath },
])
