import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { copyFileSync } from 'node:fs';

/** Ship third-party license notices with every production build. */
function legalNotices(): Plugin {
  return {
    name: 'xo-legal-notices',
    apply: 'build',
    closeBundle() {
      copyFileSync(resolve(__dirname, 'THIRD_PARTY_NOTICES.md'), resolve(__dirname, 'dist/THIRD_PARTY_NOTICES.md'));
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [legalNotices()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-compat'],
        },
      },
    },
  },
  server: {
    port: 5173,
  },
  worker: {
    format: 'es',
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
