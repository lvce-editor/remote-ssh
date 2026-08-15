import * as esbuild from 'esbuild'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { root } from './root.js'

const execFileAsync = promisify(execFile)

export const nodeVersion = 'v24.15.0'
export const nodeArchiveName = `node-${nodeVersion}-linux-x64.tar.gz`
export const nodeArchiveSha256 =
  '44836872d9aec49f1e6b52a9a922872db9a2b02d235a616a5681b6a85fec8d89'
export const nodeArchiveUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeArchiveName}`

const getSha256 = async (filePath) => {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
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
  await rm(serverArchivePath, { force: true })
  await execFileAsync('tar', [
    '-czf',
    serverArchivePath,
    '-C',
    serverBuildDirectory,
    serverFileName,
  ])
  const serverArchiveSha256 = await getSha256(serverArchivePath)
  const serverArchiveUrl = `https://github.com/lvce-editor/remote-ssh/releases/download/${version}/${serverArchiveName}`
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        nodeVersion,
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
