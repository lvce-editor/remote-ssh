import * as esbuild from 'esbuild'
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildServer } from './buildServer.js'
import { getDevServerPort } from './getDevServerPort.js'
import { getRemoteSshProcessBuildOptions } from './getRemoteSshProcessBuildOptions.js'
import { root } from './root.js'

const extension = path.join(root, 'packages', 'extension')
const sharedProcessEntryPath = fileURLToPath(
  import.meta.resolve('@lvce-editor/shared-process'),
)
const builtinExtensionsPathModule = path.join(
  path.dirname(sharedProcessEntryPath),
  'src',
  'parts',
  'BuiltinExtensionsPath',
  'BuiltinExtensionsPath.js',
)
const { getBuiltinExtensionsPath } = await import(
  pathToFileURL(builtinExtensionsPathModule).href
)
const builtinExtensionsPath = getBuiltinExtensionsPath()
const builtinExtensionPath = path.join(
  builtinExtensionsPath,
  'builtin.remote-ssh',
)
const staticConfigPath = path.join(
  builtinExtensionsPath,
  '..',
  '..',
  '..',
  'config.json',
)
const staticConfigContent = await readFile(staticConfigPath, 'utf8')
const staticConfig = JSON.parse(staticConfigContent)
const headerIndex = staticConfig.headers.length
const commitHash = path.basename(path.dirname(builtinExtensionsPath))
const browserEntry = `/${commitHash}/extensions/builtin.remote-ssh/dist/remoteSshMain.js`
const remoteSshServer = await buildServer()

staticConfig.headers.push({
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; connect-src 'self'; script-src 'self';",
  'Content-Type': 'text/javascript',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
})
staticConfig.files[browserEntry] = headerIndex

await symlink(
  extension,
  builtinExtensionPath,
  process.platform === 'win32' ? 'junction' : 'dir',
)
try {
  await writeFile(
    staticConfigPath,
    `${JSON.stringify(staticConfig, undefined, 2)}\n`,
  )
} catch (error) {
  await rm(builtinExtensionPath, { force: true, recursive: true })
  throw error
}

let filesCleaned = false

const cleanupFiles = async () => {
  if (filesCleaned) {
    return
  }
  await writeFile(staticConfigPath, staticConfigContent)
  await rm(builtinExtensionPath, { force: true, recursive: true })
  filesCleaned = true
}

const cleanupFilesSync = () => {
  if (filesCleaned) {
    return
  }
  writeFileSync(staticConfigPath, staticConfigContent)
  rmSync(builtinExtensionPath, { force: true, recursive: true })
  filesCleaned = true
}

process.on('exit', cleanupFilesSync)

const context = await esbuild.context({
  bundle: true,
  entryPoints: [path.join(extension, 'src', 'remoteSshMain.ts')],
  external: ['electron', 'node:*'],
  format: 'esm',
  outfile: path.join(extension, 'dist', 'remoteSshMain.js'),
  platform: 'browser',
  sourcemap: true,
  target: 'esnext',
})

const nodeContext = await esbuild.context(
  getRemoteSshProcessBuildOptions({
    define: remoteSshServer.define,
    outdir: path.join(extension, 'dist'),
    sourcemap: true,
  }),
)

await context.rebuild()
await context.watch()
await nodeContext.rebuild()
await nodeContext.watch()

const server = spawn(
  process.execPath,
  [
    path.join(
      root,
      'node_modules',
      '@lvce-editor',
      'server',
      'bin',
      'server.js',
    ),
    `--only-extension=${builtinExtensionPath}`,
    '--test-path=packages/e2e',
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      BUILTIN_EXTENSIONS_PATH: builtinExtensionsPath,
      PORT: getDevServerPort(),
    },
    stdio: 'inherit',
  },
)

let disposePromise

const dispose = () => {
  if (!disposePromise) {
    disposePromise = Promise.all([
      context.dispose(),
      nodeContext.dispose(),
      cleanupFiles(),
    ])
  }
  return disposePromise
}

const stop = async () => {
  server.kill()
  await dispose()
}

process.on('SIGINT', async () => {
  await stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await stop()
  process.exit(0)
})

server.on('exit', async (code) => {
  await dispose()
  process.exit(code ?? 0)
})
