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
for three hours. The initial server target is Linux x64; other remote platforms
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

The browser connector uses HTTPS and WSS; SSH is used only to install and start
LVCE on the remote host. Browser devices need no native helper. The first
release supports a single user and active browser session on Linux x64.

Install the versioned remote server archive and its matching Node runtime from
this repository's release manifest, verifying both SHA-256 checksums. Keep the
matching `builtin.remote-server` connector in the static editor build.

Use a dedicated DNS name pointing at your remote host, with TCP ports 80/443
reachable for Caddy certificate issuance and HTTPS. Install Caddy, then use:

```caddyfile
lvce.example.com {
    reverse_proxy 127.0.0.1:3774
}
```

Leave Caddy access logging disabled: WebSocket URLs contain short-lived tickets.
If a deployment requires access logging, remove query strings and Authorization
headers before recording requests. Never put the pairing secret or session
credential in a reverse-proxy URL, access log, or screenshot.

Start the gateway as your ordinary development user:

```sh
node lvce-remote-ssh-server.mjs serve-web \
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
node lvce-remote-ssh-server.mjs pair-web --port=3774
node lvce-remote-ssh-server.mjs revoke-web --port=3774
```

These commands use an owner-only Unix socket in the server's private runtime
directory. New links invalidate earlier unused links; redeeming a new link
revokes the previous browser session. Pairing links expire after ten minutes;
sessions expire after 24 hours; process-specific tickets expire after one
minute and work once. Revocation and expiry close live connections, including
remote extension processes. Restarting the gateway forgets all credentials.
Reload the browser and pair again; credentials are held only in memory.

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
