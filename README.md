# builtin.remote-ssh

Remote SSH extension for Lvce Editor.

## Browser-only Direct Sockets experiment

`packages/iwa` contains an experimental SSH terminal that runs without Electron
or a local Node.js process. It uses Chrome's Direct Sockets API for TCP and a
bundled WebAssembly SSH client for the protocol.

Direct Sockets are intentionally unavailable to ordinary websites, including a
normal GitHub Pages tab. The experiment must be installed as a Chrome Isolated
Web App (IWA). GitHub Pages can host its signed bundle and update manifest, but
opening that HTTPS URL directly cannot grant raw socket access.

Build and serve the development bundle with:

```sh
npm run dev:iwa
```

Then enable Chrome's Isolated Web App developer mode and install
`http://127.0.0.1:5193` using the dev-mode proxy in
`chrome://web-app-internals`.

This spike proves a direct browser-to-SSH connection and interactive shell. It
does not yet connect that shell to LVCE's workspace backend, install the remote
LVCE server, or verify SSH host keys. Use it only with a disposable test host.

Run `SSH: Connect`, enter an SSH destination, and LVCE opens the remote root as
`remote-ssh://host/`. You can also enter `host:/absolute/path`, an `ssh://` URI,
or a simple command such as `ssh -p 2222 user@host` to open a subfolder or use a
custom port.

Connections use SSH port 3000 by default. Supply a port in the target to
override it.

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

## Contributing

```sh
git clone git@github.com:lvce-editor/remote-ssh.git
cd remote-ssh
npm ci
npm test
```
