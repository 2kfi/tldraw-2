import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/server/index.ts' },
    format: 'esm',
    outDir: 'dist/server',
    target: 'node22',
    platform: 'node',
    bundle: true,
    clean: true,
    sourcemap: true,
    external: [
      // ponytail: keep every @tldraw/* on the single node_modules copy —
      // inlining transitive ones (editor/store/state/utils/state-react) while
      // `tldraw` stays external makes the process load them twice
      '@tldraw/editor',
      '@tldraw/store',
      '@tldraw/state',
      '@tldraw/utils',
      '@tldraw/state-react',
      '@tldraw/mentions',
      'better-sqlite3',
      'express',
      'ws',
      'multer',
      'music-metadata',
      'nanoid',
      'zod',
      'ai',
      '@ai-sdk/openai',
      '@ai-sdk/anthropic',
      '@ai-sdk/google',
      'react',
      'react-dom',
    ],
  },
  {
    // ponytail: shared schema built standalone so the .mjs spikes import the
    // same single source of truth the server and web client use
    entry: { schema: 'src/shared/schema.ts' },
    format: 'esm',
    outDir: 'dist/shared',
    target: 'node22',
    platform: 'node',
    bundle: true,
    clean: false,
    sourcemap: false,
    external: [
      '@tldraw/editor',
      '@tldraw/store',
      '@tldraw/state',
      '@tldraw/utils',
      '@tldraw/state-react',
      '@tldraw/mentions',
    ],
  },
  {
    // ponytail: vendored agent kit (prompt builders, action utils, helpers)
    // built standalone so spike-a.mjs imports it the same way the server will
    entry: { ai: 'src/server/ai/index.ts' },
    format: 'esm',
    outDir: 'dist/ai',
    target: 'node22',
    platform: 'node',
    bundle: true,
    clean: false,
    sourcemap: false,
    external: [
      '@tldraw/editor',
      '@tldraw/store',
      '@tldraw/state',
      '@tldraw/utils',
      '@tldraw/state-react',
      '@tldraw/mentions',
      'ai',
      '@ai-sdk/openai',
      '@ai-sdk/anthropic',
      '@ai-sdk/google',
    ],
  },
])