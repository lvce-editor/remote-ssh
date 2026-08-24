import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { buildServer } from './buildServer.js'
import { getRemoteSshProcessBuildOptions } from './getRemoteSshProcessBuildOptions.js'
import { root } from './root.js'

const extension = path.join(root, 'packages', 'extension')
const outdir = path.join(extension, 'dist')
const webExtension = path.join(root, 'packages', 'web-extension')
const webOutdir = path.join(webExtension, 'dist')

fs.rmSync(outdir, { force: true, recursive: true })
fs.mkdirSync(outdir, { recursive: true })
fs.rmSync(webOutdir, { force: true, recursive: true })
fs.mkdirSync(webOutdir, { recursive: true })

const server = await buildServer()

await esbuild.build({
  bundle: true,
  entryPoints: [path.join(extension, 'src', 'remoteSshMain.ts')],
  external: ['electron', 'node:*'],
  format: 'esm',
  outfile: path.join(outdir, 'remoteSshMain.js'),
  platform: 'browser',
  sourcemap: true,
  target: 'esnext',
})

await esbuild.build({
  bundle: true,
  entryPoints: [path.join(webExtension, 'src', 'remoteServerMain.ts')],
  external: ['electron', 'node:*'],
  format: 'esm',
  outfile: path.join(webOutdir, 'remoteServerMain.js'),
  platform: 'browser',
  sourcemap: true,
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
  outfile: path.join(outdir, 'remoteSshClient.js'),
  platform: 'node',
  sourcemap: true,
  target: 'node22',
})

await esbuild.build(
  getRemoteSshProcessBuildOptions({
    define: server.define,
    outdir,
    sourcemap: true,
  }),
)
