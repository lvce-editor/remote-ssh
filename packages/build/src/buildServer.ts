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
import { bundleJs } from './bundleJs.ts'
import { root } from './root.ts'

const execFileAsync = promisify(execFile)

export const nodeVersion = 'v24.15.0'
export const nodeArchiveName = `node-${nodeVersion}-linux-x64.tar.gz`
export const nodeArchiveSha256 =
  '44836872d9aec49f1e6b52a9a922872db9a2b02d235a616a5681b6a85fec8d89'
export const nodeArchiveUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeArchiveName}`
export const nodeArm64Archive = {
  name: `node-${nodeVersion}-linux-arm64.tar.gz`,
  sha256: '73afc234d558c24919875f51c2d1ea002a2ada4ea6f83601a383869fefa64eed',
  url: `https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-linux-arm64.tar.gz`,
}
export const gitExtensionVersion = 'v5.43.2'
export const gitExtensionArchiveName = `git-${gitExtensionVersion}.tar.br`
export const gitExtensionArchiveSha256 =
  'f59ecc3564b0cdc2b58a9002190304235129e3ed04acc0bf58c4df890ba68020'
export const gitExtensionArchiveUrl = `https://github.com/lvce-editor/git/releases/download/${gitExtensionVersion}/${gitExtensionArchiveName}`

const rootPackage = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8'),
) as { devDependencies: Record<string, string> }
export const lvceServerVersion =
  process.env.LVCE_REMOTE_SSH_LVCE_SERVER_VERSION ||
  rootPackage.devDependencies['@lvce-editor/server']

const getSha256 = async (filePath: string): Promise<string> => {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

const downloadVerified = async (
  url: string,
  expectedSha256: string,
): Promise<Buffer> => {
  let lastError: unknown
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

const getStaticExtensionsPath = async (
  lvceServerDirectory: string,
): Promise<string> => {
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
  serverBuildDirectory: string,
  lvceServerDirectory: string,
): Promise<void> => {
  const extensionsPath = path.join(lvceServerDirectory, 'extensions')
  const staticExtensionsPath =
    await getStaticExtensionsPath(lvceServerDirectory)
  await cp(staticExtensionsPath, extensionsPath, {
    recursive: true,
  })
  const gitPath = path.join(extensionsPath, 'builtin.git')
  const testGitExtensionPath =
    process.env.LVCE_REMOTE_SSH_TEST_GIT_EXTENSION_PATH
  if (testGitExtensionPath) {
    await rm(gitPath, { recursive: true, force: true })
    await cp(testGitExtensionPath, gitPath, { recursive: true })
  } else {
    const archive = await downloadVerified(
      gitExtensionArchiveUrl,
      gitExtensionArchiveSha256,
    )
    const tarPath = path.join(serverBuildDirectory, 'git-extension.tar')
    await mkdir(gitPath, { recursive: true })
    await writeFile(tarPath, brotliDecompressSync(archive))
    await execFileAsync('tar', ['-xf', tarPath, '-C', gitPath])
    await rm(tarPath, { force: true })
  }
  await cp(gitPath, path.join(staticExtensionsPath, 'builtin.git'), {
    recursive: true,
  })

  const containerPath = path.join(extensionsPath, 'builtin.devcontainer')
  const containerArchive = await downloadVerified(
    'https://github.com/lvce-editor/devcontainer/releases/download/v0.19.0/devcontainer-v0.19.0.tar.br',
    'd84c0e97b6ed0c50884cb5658ba37ee6791102c5dcb9c193da3c13004469da60',
  )
  const containerTar = path.join(
    serverBuildDirectory,
    'devcontainer-extension.tar',
  )
  await mkdir(containerPath, { recursive: true })
  await writeFile(containerTar, brotliDecompressSync(containerArchive))
  await execFileAsync('tar', ['-xf', containerTar, '-C', containerPath])
  await rm(containerTar, { force: true })
}

export const buildServer = async () => {
  const version = process.env.LVCE_REMOTE_SSH_SERVER_VERSION || 'dev'
  const serverBuildDirectory = path.join(root, '.tmp', 'remote-ssh-server')
  const serverFileName = 'lvce-remote-ssh-server.mjs'
  const serverArchiveName = `lvce-remote-ssh-server-${version}${process.arch === 'arm64' ? '-linux-arm64' : ''}.tar.gz`
  const serverArchivePath = path.join(root, serverArchiveName)
  const manifestName = `lvce-remote-ssh-server-manifest-${version}.json`
  const manifestPath = path.join(root, manifestName)
  await rm(serverBuildDirectory, { force: true, recursive: true })
  await mkdir(serverBuildDirectory, { recursive: true })
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
  const installedServerPackage = JSON.parse(
    await readFile(
      path.join(
        lvceServerDirectory,
        'node_modules',
        '@lvce-editor',
        'server',
        'package.json',
      ),
      'utf8',
    ),
  ) as { version: string }
  const installedLvceServerVersion = installedServerPackage.version
  await bundleJs({
    define: {
      __LVCE_REMOTE_SSH_EDITOR_VERSION__: JSON.stringify(
        installedLvceServerVersion,
      ),
      __LVCE_REMOTE_SSH_SERVER_VERSION__: JSON.stringify(version),
    },
    input: path.join(root, 'packages', 'server', 'src', 'remoteSshServer.ts'),
    outfile: path.join(serverBuildDirectory, serverFileName),
    platform: 'node',
  })
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
  const serverArchive = {
    name: serverArchiveName,
    sha256: serverArchiveSha256,
    url: serverArchiveUrl,
  }
  const arm64ArchiveName = `lvce-remote-ssh-server-${version}-linux-arm64.tar.gz`
  const arm64ArchivePath = process.env.LVCE_REMOTE_SSH_ARM64_SERVER_ARCHIVE
  const arm64ServerArchive =
    process.arch === 'arm64'
      ? serverArchive
      : arm64ArchivePath
        ? {
            name: arm64ArchiveName,
            sha256: await getSha256(arm64ArchivePath),
            url: `https://github.com/lvce-editor/remote-ssh/releases/download/${version}/${arm64ArchiveName}`,
          }
        : undefined
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        nodeVersion,
        gitExtensionVersion,
        lvceServerVersion: installedLvceServerVersion,
        platforms: {
          ...(process.arch !== 'arm64' && {
            'linux-x64': {
              node: {
                name: nodeArchiveName,
                sha256: nodeArchiveSha256,
                url: nodeArchiveUrl,
              },
              server: serverArchive,
            },
          }),
          ...(arm64ServerArchive && {
            'linux-arm64': {
              node: nodeArm64Archive,
              server: arm64ServerArchive,
            },
          }),
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
      __LVCE_REMOTE_SSH_ARM64_SERVER_ARCHIVE__: arm64ServerArchive
        ? JSON.stringify(JSON.stringify(arm64ServerArchive))
        : 'undefined',
      __LVCE_REMOTE_SSH_NODE_ARM64_ARCHIVE__: JSON.stringify(
        JSON.stringify(nodeArm64Archive),
      ),
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
      __LVCE_REMOTE_SSH_EDITOR_VERSION__: JSON.stringify(
        installedLvceServerVersion,
      ),
    },
    manifestName,
    manifestPath,
    serverArchiveName,
    serverArchivePath,
  }
}
