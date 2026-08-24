import path from 'node:path'
import { root } from './root.js'

export const getRemoteSshProcessBuildOptions = ({
  define,
  outdir,
  sourcemap = false,
}) => ({
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  bundle: true,
  define,
  entryPoints: [
    path.join(root, 'packages', 'node', 'src', 'remoteSshProcess.ts'),
  ],
  external: ['electron', 'node:*'],
  format: 'esm',
  outfile: path.join(outdir, 'remoteSshProcess.js'),
  platform: 'node',
  sourcemap,
  target: 'node22',
})
