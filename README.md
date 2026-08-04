# builtin.remote-ssh

Remote SSH extension for Lvce Editor.

Run `SSH: Connect`, enter an SSH destination, and LVCE opens the remote root as
`remote-ssh://host/`. You can also enter `host:/absolute/path`, an `ssh://` URI,
or a simple command such as `ssh -p 2222 user@host` to open a subfolder or use a
custom port.

The extension uses the system `ssh` executable and the remote machine's
`python3`. Authentication comes from the user's existing OpenSSH config, agent,
and keys. Connections are non-interactive, so password prompts are not yet
supported. New host keys are accepted by OpenSSH's `accept-new` policy; changed
host keys are rejected.

The initial real implementation executes a small, stateless helper over SSH for
each file operation. It does not install or autostart an LVCE server on the
remote machine, and it does not persist a host list.

## Contributing

```sh
git clone git@github.com:lvce-editor/remote-ssh.git
cd remote-ssh
npm ci
npm test
```
