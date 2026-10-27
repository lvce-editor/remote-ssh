// v0.23.0 uses the authenticated protocol-1 workspace backend and versioned
// installations. Keep this range explicit when changing the backend protocol.
export const minimumServerVersion = '0.23.0'
export const minimumEditorVersion = '0.125.16'

const parseVersion = (value: string): readonly number[] | undefined => {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  return match?.slice(1).map(Number)
}

export const compareVersions = (a: string, b: string): number | undefined => {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return undefined
  for (let index = 0; index < 3; index++) {
    const difference = left[index] - right[index]
    if (difference) return Math.sign(difference)
  }
  return 0
}

export const isCompatible = (installed: string, current: string): boolean => {
  const pattern = /^(v?\d+\.\d+\.\d+)-editor-(\d+\.\d+\.\d+)$/
  const older = pattern.exec(installed)
  const newer = pattern.exec(current)
  if (!older || !newer) return false
  const comparisons = [
    compareVersions(older[1], minimumServerVersion),
    compareVersions(newer[1], older[1]),
    compareVersions(older[2], minimumEditorVersion),
    compareVersions(newer[2], older[2]),
  ]
  return comparisons.every((value) => value !== undefined && value >= 0)
}

// This runs using the private remote runtime, before starting any candidate.
// Directory names are untrusted; never interpolate them into shell commands.
export const discoveryScript = `
const fs = require('fs'), path = require('path');
const root = process.argv[1], current = process.argv[2];
const parse = value => /^(v?\\d+\\.\\d+\\.\\d+)-editor-(\\d+\\.\\d+\\.\\d+)$/.exec(value);
const numeric = value => value.replace(/^v/, '').split('.').map(Number);
const compare = (a, b) => { const x = numeric(a), y = numeric(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] - y[i]; } return 0; };
const target = parse(current);
if (target) {
  const candidates = fs.readdirSync(path.join(root, 'servers')).filter(name => {
    const value = parse(name);
    if (!value || compare(value[1], '${minimumServerVersion}') < 0 || compare(value[1], target[1]) > 0 || compare(value[2], '${minimumEditorVersion}') < 0 || compare(value[2], target[2]) > 0) return false;
    try {
      const directory = path.join(root, 'servers', name);
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'remote-ssh-installation.json'), 'utf8'));
      const backend = JSON.parse(fs.readFileSync(path.join(directory, 'lvce-server/node_modules/@lvce-editor/server/package.json'), 'utf8'));
      return metadata.serverVersion === name && backend.version === value[2] && fs.statSync(path.join(directory, 'lvce-remote-ssh-server.mjs')).isFile();
    } catch { return false; }
  });
  candidates.sort((a, b) => { const x = parse(a), y = parse(b); return compare(y[1], x[1]) || compare(y[2], x[2]); });
  if (candidates[0]) process.stdout.write(candidates[0]);
}
`
