import { packageExtension } from '@lvce-editor/package-extension'
import fs from 'node:fs'
import path from 'node:path'
import { buildServer } from './buildServer.ts'
import { bundleJs } from './bundleJs.ts'
import { root } from './root.ts'

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

await bundleJs({
  input: path.join(extension, 'src', 'remoteSshMain.ts'),
  outfile: path.join(bundleDirectory, 'remoteSshMain.js'),
  platform: 'browser',
})

await bundleJs({
  input: path.join(webExtension, 'src', 'remoteServerMain.ts'),
  outfile: path.join(webBundleDirectory, 'remoteServerMain.js'),
  platform: 'browser',
})

await bundleJs({
  define: server.define,
  input: path.join(root, 'packages', 'node', 'src', 'remoteSshClient.ts'),
  outfile: path.join(bundleDirectory, 'remoteSshClient.js'),
  platform: 'node',
})

await bundleJs({
  define: server.define,
  input: path.join(root, 'packages', 'node', 'src', 'remoteSshProcess.ts'),
  outfile: path.join(bundleDirectory, 'remoteSshProcess.js'),
  platform: 'node',
})

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
