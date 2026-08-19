import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@web': fileURLToPath(new URL('./src/web', import.meta.url)),
    },
  },
  server: {
    port: 3000,
    proxy: {
      // Dev workflow: Vite on :3000 proxies API/WS to server on :3001 (set by scripts/dev.mjs).
      // Standalone (npm start) and Docker run server on :3000 directly — no proxy needed.
      '/sync': { target: 'ws://localhost:3001', ws: true },
      '/api': 'http://localhost:3001',
      '/media': 'http://localhost:3001',
    },
  },
})