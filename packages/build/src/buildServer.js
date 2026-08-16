import * as esbuild from 'esbuild'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { brotliDecompressSync } from 'node:zlib'
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { root } from './root.js'

const execFileAsync = promisify(execFile)

export const nodeVersion = 'v24.15.0'
export const nodeArchiveName = `node-${nodeVersion}-linux-x64.tar.gz`
export const nodeArchiveSha256 =
  '44836872d9aec49f1e6b52a9a922872db9a2b02d235a616a5681b6a85fec8d89'
export const nodeArchiveUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeArchiveName}`
export const gitExtensionVersion = 'v5.21.0'
export const gitExtensionArchiveName = `git-${gitExtensionVersion}.tar.br`
export const gitExtensionArchiveSha256 =
  '34bd50ece374b67e358ccf7ff45217cad223e91441c2a6442fbb2bdc9ba8cc1e'
export const gitExtensionArchiveUrl = `https://github.com/lvce-editor/git/releases/download/${gitExtensionVersion}/${gitExtensionArchiveName}`

const rootPackage = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8'),
)
export const lvceServerVersion =
  process.env.LVCE_REMOTE_SSH_LVCE_SERVER_VERSION ||
  rootPackage.devDependencies['@lvce-editor/server']

const getSha256 = async (filePath) => {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

const downloadVerified = async (url, expectedSha256) => {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(
          `Failed to download ${url}: ${response.status} ${response.statusText}`,
        )
      }
      const content = Buffer.from(await response.arrayBuffer())
      const actualSha256 = createHash('sha256').update(content).digest('hex')
      if (actualSha256 !== expectedSha256) {
        throw new Error(
          `Invalid SHA-256 for ${url}: expected ${expectedSha256}, received ${actualSha256}`,
        )
      }
      return content
    } catch (error) {
      lastError = error
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
      }
    }
  }
  throw lastError
}

const getStaticExtensionsPath = async (lvceServerDirectory) => {
  const staticRoot = path.join(
    lvceServerDirectory,
    'node_modules',
    '@lvce-editor',
    'static-server',
    'static',
  )
  const entries = await readdir(staticRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const extensionsPath = path.join(staticRoot, entry.name, 'extensions')
      const extensionsStat = await stat(extensionsPath).catch(() => undefined)
      if (extensionsStat?.isDirectory()) {
        return extensionsPath
      }
    }
  }
  throw new Error(`LVCE static server has no extension bundle in ${staticRoot}`)
}

const installBuiltinExtensions = async (
  serverBuildDirectory,
  lvceServerDirectory,
) => {
  const extensionsPath = path.join(lvceServerDirectory, 'extensions')
  await cp(await getStaticExtensionsPath(lvceServerDirectory), extensionsPath, {
    recursive: true,
  })
  const archive = await downloadVerified(
    gitExtensionArchiveUrl,
    gitExtensionArchiveSha256,
  )
  const tarPath = path.join(serverBuildDirectory, 'git-extension.tar')
  const gitPath = path.join(extensionsPath, 'builtin.git')
  await mkdir(gitPath, { recursive: true })
  await writeFile(tarPath, brotliDecompressSync(archive))
  await execFileAsync('tar', ['-xf', tarPath, '-C', gitPath])
  await rm(tarPath, { force: true })
}

export const buildServer = async () => {
  const version = process.env.LVCE_REMOTE_SSH_SERVER_VERSION || 'dev'
  const serverBuildDirectory = path.join(root, '.tmp', 'remote-ssh-server')
  const serverFileName = 'lvce-remote-ssh-server.mjs'
  const serverArchiveName = `lvce-remote-ssh-server-${version}.tar.gz`
  const serverArchivePath = path.join(root, serverArchiveName)
  const manifestName = `lvce-remote-ssh-server-manifest-${version}.json`
  const manifestPath = path.join(root, manifestName)
  await rm(serverBuildDirectory, { force: true, recursive: true })
  await mkdir(serverBuildDirectory, { recursive: true })
  await esbuild.build({
    bundle: true,
    define: {
      __LVCE_REMOTE_SSH_SERVER_VERSION__: JSON.stringify(version),
    },
    entryPoints: [
      path.join(root, 'packages', 'server', 'src', 'remoteSshServer.ts'),
    ],
    external: ['node:*'],
    format: 'esm',
    outfile: path.join(serverBuildDirectory, serverFileName),
    platform: 'node',
    target: 'node24',
  })
  const lvceServerDirectory = path.join(serverBuildDirectory, 'lvce-server')
  await mkdir(lvceServerDirectory, { recursive: true })
  await writeFile(
    path.join(lvceServerDirectory, 'package.json'),
    `${JSON.stringify({ private: true, dependencies: { '@lvce-editor/server': lvceServerVersion } }, undefined, 2)}\n`,
  )
  await execFileAsync(
    'npm',
    [
      'install',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
    ],
    {
      cwd: lvceServerDirectory,
      shell: process.platform === 'win32',
    },
  )
  await installBuiltinExtensions(serverBuildDirectory, lvceServerDirectory)
  await rm(serverArchivePath, { force: true })
  await execFileAsync('tar', [
    '-czf',
    serverArchivePath,
    '-C',
    serverBuildDirectory,
    '.',
  ])
  const serverArchiveSha256 = await getSha256(serverArchivePath)
  const serverArchiveUrl = `https://github.com/lvce-editor/remote-ssh/releases/download/${version}/${serverArchiveName}`
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        nodeVersion,
        gitExtensionVersion,
        lvceServerVersion,
        platforms: {
          'linux-x64': {
            node: {
              name: nodeArchiveName,
              sha256: nodeArchiveSha256,
              url: nodeArchiveUrl,
            },
            server: {
              name: serverArchiveName,
              sha256: serverArchiveSha256,
              url: serverArchiveUrl,
            },
          },
        },
        protocolVersion: 1,
        serverVersion: version,
      },
      undefined,
      2,
    )}\n`,
  )
  return {
    define: {
      __LVCE_REMOTE_SSH_NODE_ARCHIVE_NAME__: JSON.stringify(nodeArchiveName),
      __LVCE_REMOTE_SSH_NODE_ARCHIVE_SHA256__:
        JSON.stringify(nodeArchiveSha256),
      __LVCE_REMOTE_SSH_NODE_ARCHIVE_URL__: JSON.stringify(nodeArchiveUrl),
      __LVCE_REMOTE_SSH_NODE_VERSION__: JSON.stringify(nodeVersion),
      __LVCE_REMOTE_SSH_SERVER_ARCHIVE_NAME__:
        JSON.stringify(serverArchiveName),
      __LVCE_REMOTE_SSH_SERVER_ARCHIVE_SHA256__:
        JSON.stringify(serverArchiveSha256),
      __LVCE_REMOTE_SSH_SERVER_ARCHIVE_URL__: JSON.stringify(serverArchiveUrl),
      __LVCE_REMOTE_SSH_SERVER_VERSION__: JSON.stringify(version),
    },
    manifestName,
    manifestPath,
    serverArchiveName,
    serverArchivePath,
  }
}
