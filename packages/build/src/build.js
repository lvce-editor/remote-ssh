import { packageExtension } from '@lvce-editor/package-extension'
import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { buildServer } from './buildServer.js'
import { getRemoteSshProcessBuildOptions } from './getRemoteSshProcessBuildOptions.js'
import { root } from './root.js'

const extension = path.join(root, 'packages', 'extension')
const outdir = path.join(root, 'dist')
const bundleDirectory = path.join(outdir, 'dist')
const webExtension = path.join(root, 'packages', 'web-extension')
const webOutdir = path.join(root, 'dist-web')
const webBundleDirectory = path.join(webOutdir, 'dist')

fs.rmSync(outdir, { force: true, recursive: true })
fs.mkdirSync(bundleDirectory, { recursive: true })
fs.rmSync(webOutdir, { force: true, recursive: true })
fs.mkdirSync(webBundleDirectory, { recursive: true })
fs.copyFileSync(path.join(root, 'README.md'), path.join(outdir, 'README.md'))
fs.copyFileSync(path.join(root, 'README.md'), path.join(webOutdir, 'README.md'))
fs.copyFileSync(
  path.join(extension, 'extension.json'),
  path.join(outdir, 'extension.json'),
)
fs.copyFileSync(
  path.join(webExtension, 'extension.json'),
  path.join(webOutdir, 'extension.json'),
)

const server = await buildServer()

await esbuild.build({
  bundle: true,
  entryPoints: [path.join(extension, 'src', 'remoteSshMain.ts')],
  external: ['electron', 'node:*'],
  format: 'esm',
  outfile: path.join(bundleDirectory, 'remoteSshMain.js'),
  platform: 'browser',
  target: 'esnext',
})

await esbuild.build({
  bundle: true,
  entryPoints: [path.join(webExtension, 'src', 'remoteServerMain.ts')],
  external: ['electron', 'node:*'],
  format: 'esm',
  outfile: path.join(webBundleDirectory, 'remoteServerMain.js'),
  platform: 'browser',
  target: 'esnext',
})

await esbuild.build({
  bundle: true,
  define: server.define,
  entryPoints: [
    path.join(root, 'packages', 'node', 'src', 'remoteSshClient.ts'),
  ],
  external: ['electron', 'node:*'],
  format: 'esm',
  outfile: path.join(bundleDirectory, 'remoteSshClient.js'),
  platform: 'node',
  target: 'node22',
})

await esbuild.build(
  getRemoteSshProcessBuildOptions({
    define: server.define,
    outdir: bundleDirectory,
  }),
)

await packageExtension({
  highestCompression: true,
  inDir: outdir,
  outFile: path.join(root, 'extension.tar.br'),
})

await packageExtension({
  highestCompression: true,
  inDir: webOutdir,
  outFile: path.join(root, 'remote-server-extension.tar.br'),
})
