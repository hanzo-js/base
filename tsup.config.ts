import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'core/index': 'src/core/index.ts',
    'compat/index': 'src/compat/index.ts',
    'react/index': 'src/react/index.ts',
    'crdt/index': 'src/crdt/index.ts',
    'rest/index': 'src/rest/index.ts',
  },
  format: ['esm'],
  // Declarations come from tsc (`npm run build`): TypeScript 7 is the native
  // compiler and has no JavaScript API, which is what tsup's dts bundler drives.
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  target: 'es2020',
  outDir: 'dist',
  external: ['react'],
})
