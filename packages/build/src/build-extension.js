import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { root } from './root.js'

const extension = path.join(root, 'packages', 'extension')
const entryPoint = path.join(extension, 'src', 'remoteSshMain.ts')
const outdir = path.join(extension, 'dist')
const outfile = path.join(outdir, 'remoteSshMain.js')

fs.rmSync(outdir, { force: true, recursive: true })
fs.mkdirSync(outdir, { recursive: true })

await esbuild.build({
  bundle: true,
  entryPoints: [entryPoint],
  external: ['electron', 'node:*'],
  format: 'esm',
  outfile,
  platform: 'browser',
  sourcemap: true,
  target: 'esnext',
})
