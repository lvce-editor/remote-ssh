import { readFileSync } from 'node:fs'

declare const __LVCE_REMOTE_SSH_NODE_ARCHIVE_NAME__: string
declare const __LVCE_REMOTE_SSH_NODE_ARCHIVE_SHA256__: string
declare const __LVCE_REMOTE_SSH_NODE_ARCHIVE_URL__: string
declare const __LVCE_REMOTE_SSH_NODE_VERSION__: string
declare const __LVCE_REMOTE_SSH_SERVER_ARCHIVE_NAME__: string
declare const __LVCE_REMOTE_SSH_SERVER_ARCHIVE_SHA256__: string
declare const __LVCE_REMOTE_SSH_SERVER_ARCHIVE_URL__: string
declare const __LVCE_REMOTE_SSH_SERVER_VERSION__: string

const getDefined = (value: string | undefined, fallback: string): string => {
  return typeof value === 'string' ? value : fallback
}

export interface ServerManifest {
  readonly editorVersion?: string
  readonly nodeArchiveName: string
  readonly nodeArchiveSha256: string
  readonly nodeArchiveUrl: string
  readonly nodeVersion: string
  readonly protocolVersion: number
  readonly serverArchiveName: string
  readonly serverArchiveSha256: string
  readonly serverArchiveUrl: string
  readonly serverVersion: string
}

const embeddedManifest: ServerManifest = {
  nodeArchiveName:
    process.env.LVCE_REMOTE_SSH_NODE_ARCHIVE_NAME ||
    getDefined(
      typeof __LVCE_REMOTE_SSH_NODE_ARCHIVE_NAME__ === 'string'
        ? __LVCE_REMOTE_SSH_NODE_ARCHIVE_NAME__
        : undefined,
      'node-v24.15.0-linux-x64.tar.gz',
    ),
  nodeArchiveSha256:
    process.env.LVCE_REMOTE_SSH_NODE_ARCHIVE_SHA256 ||
    getDefined(
      typeof __LVCE_REMOTE_SSH_NODE_ARCHIVE_SHA256__ === 'string'
        ? __LVCE_REMOTE_SSH_NODE_ARCHIVE_SHA256__
        : undefined,
      '44836872d9aec49f1e6b52a9a922872db9a2b02d235a616a5681b6a85fec8d89',
    ),
  nodeArchiveUrl:
    process.env.LVCE_REMOTE_SSH_NODE_ARCHIVE_URL ||
    getDefined(
      typeof __LVCE_REMOTE_SSH_NODE_ARCHIVE_URL__ === 'string'
        ? __LVCE_REMOTE_SSH_NODE_ARCHIVE_URL__
        : undefined,
      'https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.gz',
    ),
  nodeVersion:
    process.env.LVCE_REMOTE_SSH_NODE_VERSION ||
    getDefined(
      typeof __LVCE_REMOTE_SSH_NODE_VERSION__ === 'string'
        ? __LVCE_REMOTE_SSH_NODE_VERSION__
        : undefined,
      'v24.15.0',
    ),
  protocolVersion: 1,
  serverArchiveName:
    process.env.LVCE_REMOTE_SSH_SERVER_ARCHIVE_NAME ||
    getDefined(
      typeof __LVCE_REMOTE_SSH_SERVER_ARCHIVE_NAME__ === 'string'
        ? __LVCE_REMOTE_SSH_SERVER_ARCHIVE_NAME__
        : undefined,
      'lvce-remote-ssh-server-dev.tar.gz',
    ),
  serverArchiveSha256:
    process.env.LVCE_REMOTE_SSH_SERVER_ARCHIVE_SHA256 ||
    getDefined(
      typeof __LVCE_REMOTE_SSH_SERVER_ARCHIVE_SHA256__ === 'string'
        ? __LVCE_REMOTE_SSH_SERVER_ARCHIVE_SHA256__
        : undefined,
      '',
    ),
  serverArchiveUrl:
    process.env.LVCE_REMOTE_SSH_SERVER_ARCHIVE_URL ||
    getDefined(
      typeof __LVCE_REMOTE_SSH_SERVER_ARCHIVE_URL__ === 'string'
        ? __LVCE_REMOTE_SSH_SERVER_ARCHIVE_URL__
        : undefined,
      '',
    ),
  serverVersion:
    process.env.LVCE_REMOTE_SSH_SERVER_VERSION ||
    getDefined(
      typeof __LVCE_REMOTE_SSH_SERVER_VERSION__ === 'string'
        ? __LVCE_REMOTE_SSH_SERVER_VERSION__
        : undefined,
      'dev',
    ),
}

// Packaged Electron and static-server extensions share this layout:
// config.json, static/<commit>/extensions/builtin.remote-ssh/dist/<entry>.js.
// Development extensions have no application config and keep the embedded backend.
export const readFrontendVersion = (entryUrl: string): string | undefined => {
  let config: { version?: unknown }
  try {
    config = JSON.parse(
      readFileSync(new URL('../../../../../config.json', entryUrl), 'utf8'),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (config.version === 'dev' || config.version === '0.0.0-dev')
    return undefined
  if (typeof config.version !== 'string')
    throw new Error('Invalid frontend editor version')
  const version = config.version.replace(/^v/, '')
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Unsupported frontend editor version: ${config.version}`)
  }
  return version
}

export const selectFrontendVersion = (
  value: ServerManifest,
  editorVersion: string | undefined,
): ServerManifest => {
  if (!editorVersion) return value
  return {
    ...value,
    editorVersion,
    serverVersion: `${value.serverVersion}-editor-${editorVersion}`,
  }
}

export const manifest = selectFrontendVersion(
  embeddedManifest,
  readFrontendVersion(import.meta.url),
)
