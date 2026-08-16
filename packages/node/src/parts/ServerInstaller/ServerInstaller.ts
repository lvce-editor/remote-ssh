import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { RemoteLocation } from '../RemoteSshUri/RemoteSshUri.ts'
import {
  manifest as defaultManifest,
  type ServerManifest,
} from '../ServerManifest/ServerManifest.ts'

export const downloadRequiredMarker = '__LVCE_REMOTE_SSH_DOWNLOAD_REQUIRED__'
export const installedMarker = '__LVCE_REMOTE_SSH_INSTALLED__'
export const unsupportedMarker = '__LVCE_REMOTE_SSH_UNSUPPORTED__'

const sshExecutable =
  process.platform === 'win32'
    ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
    : '/usr/bin/ssh'

const getSshArgs = (
  location: RemoteLocation,
  command: string,
): readonly string[] => {
  const portArgs = location.port ? ['-p', location.port] : []
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=accept-new',
    ...portArgs,
    '--',
    location.target,
    command,
  ]
}

const runSsh = (
  location: RemoteLocation,
  command: string,
  input: NodeJS.ReadableStream | string,
): Promise<{
  readonly code: number
  readonly stderr: string
  readonly stdout: string
}> => {
  return new Promise((resolve, reject) => {
    const child = spawn(sshExecutable, getSshArgs(location, command), {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      resolve({
        code: code ?? -1,
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
        stdout: Buffer.concat(stdout).toString('utf8'),
      })
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') {
        reject(error)
      }
    })
    if (typeof input === 'string') {
      child.stdin.end(input)
    } else {
      input.pipe(child.stdin)
    }
  })
}

const escapeShell = (value: string): string => {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

// cspell:ignore esac
export const createInstallScript = (manifest: ServerManifest): string => {
  const forceLocalTransfer =
    process.env.LVCE_REMOTE_SSH_FORCE_LOCAL_TRANSFER === '1' ? '1' : '0'
  const values = {
    nodeArchiveName: escapeShell(manifest.nodeArchiveName),
    nodeArchiveSha256: escapeShell(manifest.nodeArchiveSha256),
    nodeArchiveUrl: escapeShell(manifest.nodeArchiveUrl),
    nodeVersion: escapeShell(manifest.nodeVersion),
    serverArchiveName: escapeShell(manifest.serverArchiveName),
    serverArchiveSha256: escapeShell(manifest.serverArchiveSha256),
    serverArchiveUrl: escapeShell(manifest.serverArchiveUrl),
    serverVersion: escapeShell(manifest.serverVersion),
  }
  const configuredRoot = process.env.LVCE_REMOTE_SSH_REMOTE_ROOT
  const root = configuredRoot
    ? escapeShell(configuredRoot)
    : '"$HOME/.lvce-server"'
  return `set -eu
NODE_ARCHIVE_NAME=${values.nodeArchiveName}
NODE_SHA256=${values.nodeArchiveSha256}
NODE_URL=${values.nodeArchiveUrl}
NODE_VERSION=${values.nodeVersion}
SERVER_ARCHIVE_NAME=${values.serverArchiveName}
SERVER_SHA256=${values.serverArchiveSha256}
SERVER_URL=${values.serverArchiveUrl}
SERVER_VERSION=${values.serverVersion}
FORCE_LOCAL_TRANSFER=${forceLocalTransfer}

case "$(uname -s):$(uname -m)" in
  Linux:x86_64) ;;
  *) printf '${unsupportedMarker}%s:%s\\n' "$(uname -s)" "$(uname -m)"; exit 84 ;;
esac

ROOT=${root}
INCOMING="$ROOT/incoming/$SERVER_VERSION"
RUNTIME="$ROOT/runtimes/$NODE_VERSION"
SERVER="$ROOT/servers/$SERVER_VERSION"
mkdir -p "$INCOMING" "$ROOT/runtimes" "$ROOT/servers" "$ROOT/run"
chmod 700 "$ROOT" "$ROOT/incoming" "$INCOMING" "$ROOT/runtimes" "$ROOT/servers" "$ROOT/run"

LOCK="$ROOT/install-$SERVER_VERSION.lock"
RUNTIME_TMP=""
SERVER_TMP=""
LOCK_TRIES=0
while ! mkdir "$LOCK" 2>/dev/null; do
  if [ -x "$RUNTIME/bin/node" ] && [ -f "$SERVER/lvce-remote-ssh-server.mjs" ]; then
    printf '${installedMarker}%s\\n' "$SERVER_VERSION"
    exit 0
  fi
  LOCK_TRIES=$((LOCK_TRIES + 1))
  if [ -f "$LOCK/pid" ]; then
    LOCK_PID="$(cat "$LOCK/pid" 2>/dev/null || true)"
    case "$LOCK_PID" in
      ''|*[!0-9]*) ;;
      *)
        if ! kill -0 "$LOCK_PID" 2>/dev/null; then
          rm -rf "$LOCK"
          continue
        fi
        ;;
    esac
  elif [ "$LOCK_TRIES" -gt 10 ]; then
    rm -rf "$LOCK"
    continue
  fi
  if [ "$LOCK_TRIES" -gt 300 ]; then
    printf 'Timed out waiting for remote server install lock\\n' >&2
    exit 1
  fi
  sleep 0.1 2>/dev/null || sleep 1
done
printf '%s\n' "$$" > "$LOCK/pid"
cleanup() {
  [ -z "$RUNTIME_TMP" ] || rm -rf "$RUNTIME_TMP"
  [ -z "$SERVER_TMP" ] || rm -rf "$SERVER_TMP"
  rm -rf "$LOCK"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

download() {
  url="$1"
  destination="$2"
  [ "$FORCE_LOCAL_TRANSFER" = 1 ] && return 1
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --connect-timeout 10 --output "$destination" "$url" && return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    wget --timeout=10 --output-document="$destination" "$url" && return 0
  fi
  return 1
}

verify() {
  expected="$1"
  file="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    return 1
  fi
  [ "$actual" = "$expected" ]
}

NODE_ARCHIVE="$INCOMING/$NODE_ARCHIVE_NAME"
SERVER_ARCHIVE="$INCOMING/$SERVER_ARCHIVE_NAME"
if [ ! -x "$RUNTIME/bin/node" ]; then
  if [ ! -f "$NODE_ARCHIVE" ]; then
    download "$NODE_URL" "$NODE_ARCHIVE" || {
      rm -f "$NODE_ARCHIVE"
      printf '${downloadRequiredMarker}node\\n'
      exit 85
    }
  fi
  verify "$NODE_SHA256" "$NODE_ARCHIVE" || {
    rm -f "$NODE_ARCHIVE"
    printf '${downloadRequiredMarker}node\\n'
    exit 85
  }
  RUNTIME_TMP="$ROOT/runtimes/.$NODE_VERSION.$$"
  rm -rf "$RUNTIME_TMP"
  mkdir "$RUNTIME_TMP"
  tar -xzf "$NODE_ARCHIVE" --strip-components=1 -C "$RUNTIME_TMP"
  "$RUNTIME_TMP/bin/node" --version >/dev/null
  rm -rf "$RUNTIME"
  mv "$RUNTIME_TMP" "$RUNTIME"
  RUNTIME_TMP=""
fi

if [ ! -f "$SERVER/lvce-remote-ssh-server.mjs" ]; then
  if [ ! -f "$SERVER_ARCHIVE" ]; then
    download "$SERVER_URL" "$SERVER_ARCHIVE" || {
      rm -f "$SERVER_ARCHIVE"
      printf '${downloadRequiredMarker}server\\n'
      exit 85
    }
  fi
  verify "$SERVER_SHA256" "$SERVER_ARCHIVE" || {
    rm -f "$SERVER_ARCHIVE"
    printf '${downloadRequiredMarker}server\\n'
    exit 85
  }
  SERVER_TMP="$ROOT/servers/.$SERVER_VERSION.$$"
  rm -rf "$SERVER_TMP"
  mkdir "$SERVER_TMP"
  tar -xzf "$SERVER_ARCHIVE" -C "$SERVER_TMP"
  "$RUNTIME/bin/node" "$SERVER_TMP/lvce-remote-ssh-server.mjs" version >/dev/null
  rm -rf "$SERVER"
  mv "$SERVER_TMP" "$SERVER"
  SERVER_TMP=""
fi

rm -f "$NODE_ARCHIVE" "$SERVER_ARCHIVE"

INACTIVE_COUNT=0
for OLD_SERVER in $(ls -1dt "$ROOT"/servers/* 2>/dev/null || true); do
  [ -d "$OLD_SERVER" ] || continue
  OLD_VERSION="$(basename "$OLD_SERVER")"
  [ "$OLD_VERSION" = "$SERVER_VERSION" ] && continue
  [ -f "$ROOT/run/server-$OLD_VERSION.json" ] && continue
  INACTIVE_COUNT=$((INACTIVE_COUNT + 1))
  if [ "$INACTIVE_COUNT" -gt 5 ]; then
    rm -rf "$OLD_SERVER"
  fi
done
printf '${installedMarker}%s\\n' "$SERVER_VERSION"
`
}

const downloadFile = async (
  url: string,
  destination: string,
): Promise<void> => {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination),
  )
}

const verifyFile = async (
  filePath: string,
  expected: string,
): Promise<void> => {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  const actual = hash.digest('hex')
  if (actual !== expected) {
    throw new Error(`Downloaded archive checksum mismatch: ${actual}`)
  }
}

const transferFile = async (
  location: RemoteLocation,
  manifest: ServerManifest,
  localPath: string,
  fileName: string,
): Promise<void> => {
  const command = createTransferCommand(manifest.serverVersion, fileName)
  const result = await runSsh(location, command, createReadStream(localPath))
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to transfer ${fileName}`)
  }
}

export const createTransferCommand = (
  serverVersion: string,
  fileName: string,
): string => {
  const version = escapeShell(serverVersion)
  const name = escapeShell(fileName)
  const configuredRoot = process.env.LVCE_REMOTE_SSH_REMOTE_ROOT
  const root = configuredRoot
    ? escapeShell(configuredRoot)
    : '"$HOME/.lvce-server"'
  return `root=${root}; version=${version}; incoming="$root/incoming/$version"; mkdir -p "$incoming"; chmod 700 "$root" "$root/incoming" "$incoming"; cat > "$incoming"/${name}`
}

const transferArchives = async (
  location: RemoteLocation,
  manifest: ServerManifest,
  required: ReadonlySet<'node' | 'server'>,
): Promise<void> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lvce-remote-ssh-'))
  try {
    const archives = [
      {
        kind: 'node' as const,
        name: manifest.nodeArchiveName,
        sha256: manifest.nodeArchiveSha256,
        url: manifest.nodeArchiveUrl,
      },
      {
        kind: 'server' as const,
        name: manifest.serverArchiveName,
        sha256: manifest.serverArchiveSha256,
        url: manifest.serverArchiveUrl,
      },
    ]
    for (const archive of archives) {
      if (!required.has(archive.kind)) {
        continue
      }
      const localPath = path.join(directory, archive.name)
      await downloadFile(archive.url, localPath)
      await verifyFile(localPath, archive.sha256)
      await transferFile(location, manifest, localPath, archive.name)
    }
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

export const installServer = async (
  location: RemoteLocation,
  manifest: ServerManifest = defaultManifest,
): Promise<void> => {
  const script = createInstallScript(manifest)
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await runSsh(location, '/bin/sh -s', script)
    if (result.code === 84 || result.stdout.includes(unsupportedMarker)) {
      throw new Error(
        `LVCE Remote SSH Server currently supports Linux x64 only: ${result.stdout.trim()}`,
      )
    }
    if (result.code === 0 && result.stdout.includes(installedMarker)) {
      return
    }
    if (result.code === 85 && result.stdout.includes(downloadRequiredMarker)) {
      const required = new Set<'node' | 'server'>()
      if (result.stdout.includes(`${downloadRequiredMarker}node`)) {
        required.add('node')
      }
      if (result.stdout.includes(`${downloadRequiredMarker}server`)) {
        required.add('server')
      }
      await transferArchives(location, manifest, required)
      continue
    }
    throw new Error(
      result.stderr || result.stdout.trim() || 'Remote SSH server setup failed',
    )
  }
  throw new Error('Remote SSH server setup did not complete after transfer')
}

export const _escapeShell = escapeShell
