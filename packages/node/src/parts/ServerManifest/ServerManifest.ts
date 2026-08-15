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

export const manifest: ServerManifest = {
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
