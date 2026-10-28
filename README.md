# builtin.remote-ssh

Remote SSH extension for Lvce Editor. Requires Lvce Editor 0.114.4 or newer.

Select **Remote SSH** in the **Output** panel to see timestamped connection
progress and errors. Connections and restored workspaces include their elapsed time in milliseconds,
measured from the start of the connection attempt until the workspace opens.

## Authenticated remote web workspaces

The separate web-compatible `builtin.remote-server` connector connects the
static editor to a loopback LVCE gateway behind HTTPS/WSS ingress. Files,
terminals, search, and supported remote Node extension processes execute on the
remote machine. The desktop `builtin.remote-ssh` extension keeps its existing
SSH transport. See [Remote browser development (HTTPS)](#remote-browser-development-https)
for deployment, pairing, revocation, and connection limits.

Run `SSH: Connect`, enter an SSH destination, and LVCE opens the remote root as
`remote-ssh://host/`. You can also enter `host:/absolute/path`, an `ssh://` URI,
or a simple command such as `ssh -p 2222 user@host` to open a subfolder or use a
custom port.

When `~/.ssh/config` contains literal `Host` aliases, the connection prompt
offers them as choices while continuing to accept a free-form destination.
Wildcard and negated patterns are omitted. Missing, unreadable, empty, or
malformed config entries fall back to the free-form prompt.

Packaged frontends select the exact published `@lvce-editor/server` version
from the application config used by About. The checksum-verified SSH bootstrap
stays tied to the extension release; when necessary, its private Node/npm runtime
installs the matching backend from the public npm registry, with package integrity
checks and lifecycle scripts disabled. This backend update requires registry
access from the remote host. An unavailable matching version fails installation
without replacing existing versions. The verified native terminal build is retained
only when its package version matches the requested backend; a backend requiring
a different native build needs an updated bootstrap release. Each frontend/extension
pair has its own installation, sockets, and terminal CLI launcher; reconnects reuse that pair and
older clients can keep their installations. `lvce -v` reads the installed backend's
package version. Unpackaged development extensions keep their embedded backend.

The extension uses the system `ssh` executable. Authentication comes from the
user's existing OpenSSH config, agent, and keys. Connections are non-interactive,
so password prompts are not yet supported. New host keys are accepted by
OpenSSH's `accept-new` policy; changed host keys are rejected.

On first connection, LVCE installs a private Node.js runtime and a versioned
filesystem server under `~/.lvce-server`. The installer first downloads on the
remote and falls back to downloading and transferring from the client. Release
hashes are verified before either archive is installed. No system Node.js or
Python installation is required.

The filesystem server runs as a user-owned background process on a protected
Unix socket. One SSH connector multiplexes filesystem requests for the open
remote, and the server remains available for reconnects until it has been idle
for three hours. The initial server target is Linux x64 and ARM64; other remote platforms
report an explicit unsupported-platform error.

## Local services and remote workspace transport

Opening an SSH workspace keeps the editor's shared process, local filesystem,
recent folders, and user settings on the local machine. Workspace paths retain
the `remote-ssh://` scheme, so remote reads and writes go through this
extension's filesystem provider.

The extension owns SSH tunnels, authentication, remote search, and remote
process WebSockets. The renderer passes MessagePorts through extension
management without receiving SSH credentials or a backend URL. Only this
extension needs loopback WebSocket access in its content security policy.

An extension can opt a declared Node RPC into remote execution with
`"onRemote": "runOnRemote"`. Its browser worker stays local; extension management
transfers a scoped MessagePort to the workspace transport. Git uses this path
for its native process. RPC declarations without that option remain local.
Terminal connections also use the transport, with their working directories
validated and translated by Remote SSH.

## Contributing

```sh
git clone git@github.com:lvce-editor/remote-ssh.git
cd remote-ssh
npm ci
npm test
```

### Testing a Git extension build over SSH

Set `LVCE_REMOTE_SSH_TEST_GIT_EXTENSION_PATH` to an absolute path to a built Git extension before `npm run build`. The test server archive and the browser test then use that build on both machines. Leave it unset to use the pinned Git release.

An optional `LVCE_REMOTE_SSH_TEST_GIT_SCENARIO` absolute module path can export `test({ page, expect, sshServer, port, socketUrls, sockets })`. The real SSH test invokes it after connecting, editing and saving a remote file, and checking the Git source control view. The harness owns server, browser, and fixture cleanup.

## Remote browser development (HTTPS)

When connecting to a local or private-network gateway, allow device or local
network access if the browser asks. Public HTTPS gateways do not require this
permission. A blocked request, an invalid certificate, or an unreachable gateway
shows a pairing error; correct the connection settings and try again.

The browser connector uses HTTPS and WSS; SSH is used only to install and start
LVCE on the remote host. Browser devices need no native helper. The first
release supports a single user and active browser session on Linux x64 and ARM64.

Install the versioned remote server archive and its matching Node runtime from
this repository's release manifest, verifying both SHA-256 checksums. Keep the
matching `builtin.remote-server` connector in the static editor build. On a
Linux x64 or ARM64 host with `curl`, `jq`, `tar`, and `sha256sum`, install as your ordinary
development user:

```sh
set -eu
umask 077
release_tag='<release-tag>' # Choose a release with ARM64 support for ARM64 hosts.
install_dir="$HOME/.local/share/lvce-web/$release_tag"
mkdir -p "$install_dir"
cd "$install_dir"
curl --fail --location \
  "https://github.com/lvce-editor/remote-ssh/releases/download/$release_tag/lvce-remote-ssh-server-manifest-$release_tag.json" \
  --output manifest.json
case "$(uname -m)" in
  x86_64) remote_platform=linux-x64 ;;
  aarch64|arm64) remote_platform=linux-arm64 ;;
  *) echo "Unsupported remote architecture" >&2; exit 1 ;;
esac
for artifact in node server; do
  url=$(jq -er ".platforms[\"$remote_platform\"].$artifact.url" manifest.json)
  digest=$(jq -er ".platforms[\"$remote_platform\"].$artifact.sha256" manifest.json)
  curl --fail --location "$url" --output "$artifact.tar.gz" || exit 1
  printf '%s  %s\n' "$digest" "$artifact.tar.gz" | sha256sum --check - || exit 1
done
mkdir -p node server
tar -xzf node.tar.gz --strip-components=1 -C node
tar -xzf server.tar.gz -C server
```

The private Node runtime is independent of any system Node installation. Keep
this installation directory as the working directory for the commands below.

Use a dedicated DNS name pointing at your remote host, with TCP ports 80/443
reachable for Caddy certificate issuance and HTTPS. Install Caddy, then use:

```caddyfile
{
    log default {
        format filter {
            wrap json
            fields {
                request>uri delete
                request>headers delete
            }
        }
    }
}

lvce.example.com {
    reverse_proxy 127.0.0.1:3774
}
```

This configuration removes request URLs and headers from Caddy runtime logs.
Leave access logging disabled: WebSocket URLs contain short-lived tickets.
If a deployment requires access logging, apply the same
[log filters](https://caddyserver.com/docs/caddyfile/directives/log#filter)
to that logger. Never put the pairing secret or session credential in a
reverse-proxy URL, access log, or screenshot.

Start the gateway as your ordinary development user:

```sh
./node/bin/node ./server/lvce-remote-ssh-server.mjs serve-web \
  --port=3774 \
  --public-url=https://lvce.example.com \
  --allowed-origin=https://lvce-editor.github.io \
  --workspace=/home/user/project
```

The backend and gateway bind to loopback. Only Caddy faces the network. In the
GitHub Pages editor, run **Remote Server: Connect with Pairing URL**, then paste
the printed URL into the editor prompt. Do not navigate to the pairing URL.
Use **Remote Server: Connection Status** to inspect pairing and **Remote Server:
Disconnect** to revoke the session and close its transports.

Generate a new link or revoke browser access over an existing SSH session:

```sh
./node/bin/node ./server/lvce-remote-ssh-server.mjs pair-web --port=3774
./node/bin/node ./server/lvce-remote-ssh-server.mjs revoke-web --port=3774
```

These commands use an owner-only Unix socket in the server's private runtime
directory. New links invalidate earlier unused links; redeeming a new link
revokes the previous browser session. Pairing links expire after ten minutes;
sessions expire after 24 hours; process-specific tickets expire after one
minute and work once. Revocation and expiry close live connections, including
remote extension processes. Restarting the gateway forgets all credentials.
Reloading reuses the valid session saved in extension secret storage. Pair again
after session expiration, revocation, or a gateway restart.
If the backend stops, the gateway exits too. Start `serve-web` again and use its
fresh pairing link.

Origin checks accept an exact origin, without a path. All projects under the
same GitHub Pages hostname share that origin. Use a dedicated frontend origin
when other projects on that hostname should not share this trust boundary.
Pairing grants filesystem and terminal access as the server's OS user; the
selected folder is not a sandbox. Run under a separate OS account or container
when isolation is required.

For machines behind NAT, an externally operated outbound HTTPS tunnel can
replace Caddy ingress. Forward it only to the loopback gateway, preserve Origin
and WebSocket upgrades, and retain LVCE pairing. The tunnel operator terminates
TLS unless the chosen product provides a separately verified end-to-end mode;
choose an operator you trust with workspace traffic. An LVCE-managed relay is
not required by this deployment.

Connection failures do not replay filesystem writes or terminal input. Preserve
unsaved buffers, reconnect, and verify the remote file before saving again.
Protocol mismatches require updating the connector and server together. A 401
requires a fresh pairing link; a 429 requires waiting one minute. For CORS
failures, verify `--allowed-origin`; for TLS/WebSocket failures, verify the DNS
name, valid certificate, and proxy upgrade support. Private-network deployments
may also require the browser's local-network permission.

The gateway limits each session to 32 workspace connections, 64 outstanding
tickets, 120 HTTP/upgrade attempts per minute, and 8 MiB WebSocket payloads and
queues. The payload limit includes JSON and base64 encoding overhead.

### Browser acceptance tests

Build the static editor and bundled remote backend, then run a browser against
separate HTTPS frontend and gateway origins:

```sh
PATH_PREFIX=/lvce-editor npm run build:static
LVCE_REMOTE_WEB_PATH_PREFIX=/lvce-editor LVCE_REMOTE_WEB_BROWSER=chromium npm run e2e:web
```

The CI matrix repeats this scenario in Chromium, Firefox, and WebKit. It tests
remote editing, terminal commands, automatic file watching, search, Git, a real
TypeScript compiler running through a declared remote Node process, and unsaved
text across disconnect. Fixtures isolate application state and remove their
backend processes and temporary files on completion. Self-signed certificates
are accepted only by the fixture browser context.

For a published static frontend, set `LVCE_REMOTE_WEB_FRONTEND_URL` to its HTTPS
URL. That smoke test uses the deployed assets and their built-in extensions; it
omits the injected TypeScript test extension. Chromium is granted local-network
permission to reach the fixture gateway on this machine.

## Cloudflare tunnel (LVCE-managed access)

After extracting the Node and server release archives as described above, run on the remote Linux x64 or ARM64 host:

```sh
./node/bin/node ./server/lvce-remote-ssh-server.mjs --enable-cloudflare-tunnel --workspace=/absolute/project
./node/bin/node ./server/lvce-remote-ssh-server.mjs --disable-cloudflare-tunnel
```

Enable stays in the foreground. Sign in at `https://lvce-editor.dev/cloudflare` and choose **Claim tunnel access** (one slot per user while capacity is available). Open the CLI approval URL, compare the code, approve the machine, then sign in to the same LVCE account in the editor and use **Remote Server: Connect from LVCE Account**. Managed tunnels do not issue or accept pairing URLs. No Cloudflare account, domain, inbound port, Caddy installation, or browser-machine daemon is required for managed access. Operators configure their Cloudflare account and zone; see [backend deployment setup](https://github.com/lvce-editor/backend-2/blob/main/docs/cloudflare.md).

The default account backend is `https://lvce-editor.dev`; its Cloudflare connection page is `https://lvce-editor.dev/cloudflare`. Use `https://lvce-editor.dev/cloudflare/callback` as the OAuth redirect URI for this deployment. The old Render subdomain is disabled.

Options: `--backend-url=https://YOUR_BACKEND`, `--port=3774`, `--allowed-origin=https://lvce-editor.github.io`, and `--cloudflared-path=/absolute/path`. The default downloads official cloudflared 2026.10.3 for Linux x64 and ARM64 and verifies SHA-256 before execution. An override must support `tunnel run --token-file` (cloudflared 2025.4.0+). Tokens are stored in private files and excluded from arguments and output.

For LVCE-managed tunnels, Ctrl+C stops the connector but retains the tunnel and hostname. Run enable again with the same root and port to reconnect without another enrollment. `--disable-cloudflare-tunnel` or removing the machine deletes the tunnel; the claim remains reserved until **Release tunnel access and remove its tunnel** is used on the account page. Optional user-owned Cloudflare tunnels still require a domain and are removed on shutdown. After an abrupt crash or failed cleanup, rerun disable or remove the machine in backend account connections. Keep the saved private management credential until cleanup succeeds. Disable uses the same port and OS account as enable. This version does not install a system service; keep the foreground process running while using the workspace. Pairing grants the privileges of the remote OS account; the workspace path is not a sandbox.

An expired or disabled saved enrollment is cleaned up before the CLI requests a new approval. Authentication errors, unavailable backends, or failed cleanup retain the saved credential so cleanup can be retried. On older releases that stop with HTTP 410, run `--disable-cloudflare-tunnel` and then enable again to obtain a fresh approval URL; this keeps the tunnel access claim.

Cloudflare management state is saved in `$LVCE_REMOTE_SSH_ROOT/run/cloudflare-PORT.json` (default `~/.lvce-server/run/`). Use the same root for enable and disable. Keep this file private and retain it after a failed cleanup.

Linux ARM64 uses a native server archive (including its terminal module), a separately verified Node runtime, and the ARM64 cloudflared release. Runtime selection follows the remote host architecture, independently of the client machine. Older releases without an ARM64 server entry fail before downloading an incompatible server.

The browser connector keeps its expiring session in extension secret storage so reloading can reuse it. The remote workspace reference in the Pages URL and Open Recent contains no credentials. Switching folders closes active sockets; **Remote Server: Disconnect** revokes the session and removes its saved credential. A gateway restart, revocation or session expiration requires a fresh pairing URL.

### Browser connection benchmark

In a paired remote workspace, run **Remote Server: Benchmark Connection** from the
command palette. After about five seconds, a read-only JSON report opens locally
in the editor. It includes first-response time (including authentication and
connection setup), warm request latency samples, median/p95 latency, jitter,
completed requests, stalls over 250 ms, and interruption/deadline information.
The test only reads workspace metadata, uses a separate authenticated socket,
and closes that socket at its deadline or when the workspace disconnects.

This measures the complete browser-to-filesystem route, including a Cloudflare
tunnel when used. It cannot attribute latency to Cloudflare separately and does
not measure bulk download bandwidth. No file contents, endpoint credentials or
workspace paths are included in the report. Only the latest report is retained
in memory; copy its JSON before running another benchmark or reloading.

Browser text reads and writes use UTF-8 JSON strings directly. Base64 remains
appropriate for the desktop SSH provider, which returns binary-safe blobs for
image previews and other non-text files.

### Connect using your LVCE account

For an approved Cloudflare tunnel, sign in to the same LVCE account in the web
editor, then run **Remote Server: Connect from LVCE Account**. The machine approval
is shared across browsers and computers; each browser receives an independent
session. Opening a saved workspace link in another signed-in browser also works.
No pairing URL needs to be copied. Existing machines need an updated remote server
and one restart to register account access; their tunnel and claim are reused.

Browser sessions are saved in local secret storage and checked against the active
LVCE account on restore. Signing out or switching accounts disconnects that
browser. Removing the tunnel or releasing its claim denies new access and closes
account sessions within 45 seconds (30-second checks plus 15-second timeout).
Backend outages also close account sessions on the next failed check; reconnect
from your account once connectivity returns. Managed tunnels require a grant from the owning LVCE account; manual pairing
URLs are rejected even when supplied directly to the gateway. Manual pairing
remains available only for unmanaged servers, and `revoke-web` closes all sessions locally.

### Background server updates

`remoteSsh.updateMode` accepts `background` (the default) or `foreground`.
The setting is read when the extension starts its SSH helper; reload after changing it.

Background mode opens the workspace using an installed compatible server while
installing the current server into its separate versioned directory. Compatibility
requires server v0.23.0 or newer, coordinated editor backend 0.125.16 or newer,
no version newer than the client, protocol 1, and the required backend capabilities.
Unknown/development versions, missing private runtimes, first installations and
incompatible servers use the foreground installer.

After the new backend passes a filesystem probe, outstanding helper requests drain
and new requests and backend sockets switch to it. Existing terminals, watchers,
extension sessions, CLI clients and port forwards retain their original transport
for the workspace lifetime; their state is not replayed into another process.
Disconnecting disposes both transports and cancels any update. A failed installation
or handover keeps the original server usable. Update results are available through
`SshFileSystem.getProgress` for diagnostics.
