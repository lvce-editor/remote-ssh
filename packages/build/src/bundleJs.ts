import { babel } from '@rollup/plugin-babel'
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import replace from '@rollup/plugin-replace'
import { isBuiltin } from 'node:module'
import { rollup } from 'rollup'

interface BundleOptions {
  readonly define?: Record<string, string>
  readonly input: string
  readonly outfile: string
  readonly platform: 'browser' | 'node'
}

export const bundleJs = async ({
  define = {},
  input,
  outfile,
  platform,
}: BundleOptions): Promise<void> => {
  const bundle = await rollup({
    external: (id) => id === 'electron' || isBuiltin(id),
    input,
    plugins: [
      babel({
        babelHelpers: 'bundled',
        extensions: ['.js', '.ts'],
        presets: ['@babel/preset-typescript'],
      }),
      // @ts-expect-error The plugin's CommonJS declarations do not describe its ESM default export.
      replace({ preventAssignment: true, values: define }),
      nodeResolve({ browser: platform === 'browser' }),
      // @ts-expect-error The plugin's CommonJS declarations do not describe its ESM default export.
      commonjs(),
    ],
    preserveEntrySignatures: 'strict',
    treeshake: {
      propertyReadSideEffects: false,
    },
  })
  try {
    await bundle.write({
      banner:
        platform === 'node'
          ? "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
          : undefined,
      file: outfile,
      format: 'es',
      freeze: false,
      generatedCode: {
        constBindings: true,
        objectShorthand: true,
      },
      inlineDynamicImports: true,
    })
  } finally {
    await bundle.close()
  }
}
