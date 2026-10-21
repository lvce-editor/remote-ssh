import { RemoteSshError } from '../RemoteSshError/RemoteSshError.ts'

// cspell:ignore ETARGET notarget

export type Stage =
  | 'connect'
  | 'install'
  | 'start'
  | 'forward'
  | 'backend'
  | 'session'

const stages: Record<Stage, readonly [string, string]> = {
  backend: [
    'E_SSH_BACKEND_FAILED',
    'SSH connected, but the remote workspace backend connection failed. The server may have stopped or SSH forwarding may be blocked. Check the remote server log',
  ],
  connect: [
    'E_SSH_CONNECT_FAILED',
    'Could not establish the SSH connection. Check the host, SSH port, network, and SSH configuration',
  ],
  forward: [
    'E_SSH_FORWARD_FAILED',
    'SSH connected and the remote server started, but the local port forward could not be created',
  ],
  install: [
    'E_SSH_INSTALL_FAILED',
    'SSH connected, but installing the LVCE remote server failed. Check the download, free disk space, and permissions on the remote server directory',
  ],
  session: [
    'E_SSH_CONNECTION_LOST',
    'The SSH session to the remote server ended',
  ],
  start: [
    'E_SSH_SERVER_START_FAILED',
    'SSH connected, but the LVCE remote server failed to start or complete its handshake. Check the remote server log',
  ],
}

export const create = (
  target: string,
  stage: Stage,
  cause: unknown,
  logPath: string,
): RemoteSshError => {
  const originalDetail = cause instanceof Error ? cause.message : String(cause)
  const detail = originalDetail
    .split('\n')
    .filter((line) => !/^#{4,}(?:\s+\d+(?:\.\d+)?%)?$/.test(line.trim()))
    .join('\n')
    .trim()
  let [code, message] = stages[stage]
  let shownDetail = detail
  if (
    stage === 'install' &&
    /(?:npm ERR!|npm error) code ETARGET/i.test(originalDetail) &&
    /(?:npm ERR!|npm error) notarget No matching version found for @lvce-editor\/server@/i.test(
      originalDetail,
    )
  ) {
    code = 'E_SSH_SERVER_VERSION_NOT_FOUND'
    message =
      'SSH connected, but the requested LVCE remote server version is not available on npm yet. It may still be going through publication checks; try again in a few minutes'
    shownDetail = ''
  } else if (stage === 'connect') {
    if (
      /Permission denied \([^)]*\)|Authentication failed|Too many authentication failures/i.test(
        detail,
      )
    ) {
      code = 'E_SSH_AUTHENTICATION_FAILED'
      message =
        'The SSH server rejected authentication. Check the SSH user, key, and agent; interactive password prompts are disabled'
    } else if (
      /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(
        detail,
      )
    ) {
      code = 'E_SSH_HOST_KEY_FAILED'
      message =
        'SSH host identity verification failed. Verify the host fingerprint and the known_hosts entry'
    } else if (/Connection refused/i.test(detail)) {
      code = 'E_SSH_CONNECTION_REFUSED'
      message =
        'The SSH connection was refused. Check that SSH is listening on the configured port'
    } else if (/Could not resolve hostname/i.test(detail)) {
      code = 'E_SSH_HOST_NOT_FOUND'
      message =
        'The SSH hostname could not be resolved. Check the hostname, SSH alias, and DNS'
    } else if (
      /Connection timed out|No route to host|Network is unreachable/i.test(
        detail,
      )
    ) {
      code = 'E_SSH_HOST_UNREACHABLE'
      message =
        'The SSH host could not be reached. It may be offline, or the network, firewall, or SSH port may be blocking the connection'
    }
  }
  const log = ['start', 'backend', 'session'].includes(stage)
    ? ` (${logPath})`
    : ''
  return new RemoteSshError(
    `${target}: ${message}${log}${shownDetail ? '. Details: ' + shownDetail : ''}`,
    code,
    cause,
  )
}
