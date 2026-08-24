import * as esbuild from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { root } from './root.js'

const sourceDirectory = path.join(root, 'packages', 'iwa')
const outputDirectory = path.join(root, '.tmp', 'remote-ssh-iwa')

const copy = async (source, target) => {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(source, target)
}

export const buildIwa = async () => {
  const sshClientPackage = fileURLToPath(
    import.meta.resolve('sshclient-wasm/package.json'),
  )
  const sshClientDirectory = path.dirname(sshClientPackage)

  await fs.rm(outputDirectory, { force: true, recursive: true })
  await fs.mkdir(outputDirectory, { recursive: true })

  await esbuild.build({
    bundle: true,
    entryPoints: [path.join(sourceDirectory, 'src', 'main.ts')],
    format: 'esm',
    outfile: path.join(outputDirectory, 'app.js'),
    platform: 'browser',
    target: 'chrome138',
  })

  await Promise.all([
    copy(
      path.join(sourceDirectory, 'public', 'index.html'),
      path.join(outputDirectory, 'index.html'),
    ),
    copy(
      path.join(sourceDirectory, 'public', 'style.css'),
      path.join(outputDirectory, 'style.css'),
    ),
    copy(
      path.join(sourceDirectory, 'public', 'icon.svg'),
      path.join(outputDirectory, 'icon.svg'),
    ),
    copy(
      path.join(sourceDirectory, 'public', 'icon.png'),
      path.join(outputDirectory, 'icon.png'),
    ),
    copy(
      path.join(
        sourceDirectory,
        'public',
        '.well-known',
        'manifest.webmanifest',
      ),
      path.join(outputDirectory, '.well-known', 'manifest.webmanifest'),
    ),
    copy(
      path.join(sshClientDirectory, 'dist', 'sshclient.wasm'),
      path.join(outputDirectory, 'sshclient.wasm'),
    ),
    copy(
      path.join(sshClientDirectory, 'dist', 'wasm_exec.js'),
      path.join(outputDirectory, 'wasm_exec.js'),
    ),
  ])
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildIwa()
}
