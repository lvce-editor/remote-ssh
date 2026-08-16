import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { buildServer } from './buildServer.js'
import { root } from './root.js'

const extension = path.join(root, 'packages', 'extension')
const outdir = path.join(extension, 'dist')

fs.rmSync(outdir, { force: true, recursive: true })
fs.mkdirSync(outdir, { recursive: true })

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
