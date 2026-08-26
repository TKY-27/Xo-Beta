import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';

/** Ship third-party license notices with every production build. */
function legalNotices(): Plugin {
  return {
    name: 'xo-legal-notices',
    apply: 'build',
    closeBundle() {
      copyFileSync(resolve(__dirname, 'LICENSE'), resolve(__dirname, 'dist/LICENSE'));
      copyFileSync(resolve(__dirname, 'THIRD_PARTY_NOTICES.md'), resolve(__dirname, 'dist/THIRD_PARTY_NOTICES.md'));
      const distDocs = resolve(__dirname, 'dist/docs');
      mkdirSync(distDocs, { recursive: true });
      copyFileSync(resolve(__dirname, 'docs/ASSET_MANIFEST.md'), resolve(distDocs, 'ASSET_MANIFEST.md'));
      copyFileSync(resolve(__dirname, 'docs/ASSET_CHECKSUMS.txt'), resolve(distDocs, 'ASSET_CHECKSUMS.txt'));
    },
  };
}

export default defineConfig({
  // Cloudflare serves this project at the origin root. Absolute bundle URLs
  // keep SPA fallbacks such as /play/neocity from resolving ./assets beneath
  // the deep route and receiving HTML in place of JavaScript.
  base: '/',
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
