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
const gitExtensionPath = path.join(
  root,
  '.tmp',
  'remote-ssh-server',
  'lvce-server',
  'extensions',
  'builtin.git',
)
const gitExtensionManifest = await readJson<ExtensionManifest>(
  path.join(gitExtensionPath, 'extension.json'),
)
await cp(
  gitExtensionPath,
  path.join(root, 'dist', commitHash, 'extensions', gitExtensionManifest.id),
  { force: true, recursive: true },
)
const containerExtensionPath = path.join(
  root,
  '.tmp',
  'remote-ssh-server',
  'lvce-server',
  'extensions',
  'builtin.devcontainer',
)
const containerManifest = await readJson<ExtensionManifest>(
  path.join(containerExtensionPath, 'extension.json'),
)
await cp(
  containerExtensionPath,
  path.join(root, 'dist', commitHash, 'extensions', containerManifest.id),
  { force: true, recursive: true },
)
const extraExtensions = [
  webExtensionManifest,
  gitExtensionManifest,
  containerManifest,
].map((manifest) => ({
  ...manifest,
  path: `${process.env.PATH_PREFIX || ''}/${commitHash}/extensions/${manifest.id}`,
}))
const extraIds = new Set(extraExtensions.map(({ id }) => id))
for (const file of ['extensions.json', 'webExtensions.json']) {
  const location = path.join(configDirectory, file)
  const extensions = await readJson<ExtensionManifest[]>(location)
  await writeJson(location, [
    ...extensions.filter(({ id }) => !extraIds.has(id)),
    ...extraExtensions.map((extension) =>
      file === 'webExtensions.json' ? { ...extension, isWeb: true } : extension,
    ),
  ])
}
