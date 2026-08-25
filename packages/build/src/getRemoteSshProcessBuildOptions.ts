import type { BuildOptions } from 'esbuild'
import path from 'node:path'
import { root } from './root.ts'

interface RemoteSshProcessBuildOptions {
  readonly define: Record<string, string>
  readonly outdir: string
  readonly sourcemap?: boolean
}

type RemoteSshProcessEsbuildOptions = BuildOptions & {
  readonly entryPoints: string[]
  readonly outfile: string
}

export const getRemoteSshProcessBuildOptions = ({
  define,
  outdir,
  sourcemap = false,
}: RemoteSshProcessBuildOptions): RemoteSshProcessEsbuildOptions => ({
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
