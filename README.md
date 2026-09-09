# builtin.remote-ssh

Remote SSH extension for Lvce Editor. Requires Lvce Editor 0.114.4 or newer.

## Authenticated remote web experiment

The remote server can expose an LVCE workspace to the hosted web editor without
requiring Electron, a local Node.js bridge, or browser raw-socket access. The
workspace backend still runs on the remote machine, while the browser connects
to it through an authenticated HTTPS/WebSocket gateway. The browser connector
is packaged separately as the web-compatible `builtin.remote-server` extension;
the existing `builtin.remote-ssh` extension remains Node-hosted so its SSH
transport keeps working unchanged in desktop and remote extension hosts.

The gateway deliberately listens only on `127.0.0.1`. Put it behind a trusted
HTTPS reverse proxy, private-network ingress, or outbound tunnel that provides
the public URL. Do not publish the plain local port directly to the internet.
For local development only, loopback `http://` public URLs are also accepted
and produce loopback `ws://` connections.

Start the experiment on the remote machine with:

```sh
node lvce-remote-ssh-server.mjs serve-web \
  --port=3774 \
  --public-url=https://lvce.example.com \
  --allowed-origin=https://lvce-editor.github.io \
  --workspace=/home/user/project
```

The command prints a pairing URL. In the hosted editor, run
`Remote Server: Connect with Pairing URL` and paste it. The secret stays in the
URL fragment, is exchanged once for an in-memory session, and is never sent to
the hosted page server. Each workspace WebSocket then uses a separate,
single-use ticket that expires after five minutes. The gateway also validates
the browser `Origin` before proxying an approved workspace process to the
loopback-only LVCE backend. Sessions expire after 24 hours or immediately when
the gateway restarts.

This is a single-user prototype. Sessions and pairing state are intentionally
lost when the gateway restarts; persistent device enrollment, revocation UI,
rate limiting, audit logs, and an opinionated tunnel deployment remain future
work. A paired session can use terminals and edit files as the remote server
user, so it must be treated like shell access.

Run `SSH: Connect`, enter an SSH destination, and LVCE opens the remote root as
`remote-ssh://host/`. You can also enter `host:/absolute/path`, an `ssh://` URI,
or a simple command such as `ssh -p 2222 user@host` to open a subfolder or use a
custom port.

When `~/.ssh/config` contains literal `Host` aliases, the connection prompt
offers them as choices while continuing to accept a free-form destination.
Wildcard and negated patterns are omitted. Missing, unreadable, empty, or
malformed config entries fall back to the free-form prompt.

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

An optional `LVCE_REMOTE_SSH_TEST_GIT_SCENARIO` absolute module path can export `test({ page, expect, sshServer, port, socketUrls })`. The real SSH test invokes it after connecting, editing and saving a remote file, and checking the Git source control view. The harness owns server, browser, and fixture cleanup.
