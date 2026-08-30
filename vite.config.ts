import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

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

function buildHash(): string {
  const supplied = process.env.CF_PAGES_COMMIT_SHA ?? process.env.GITHUB_SHA;
  if (supplied && /^[0-9a-f]{7,64}$/i.test(supplied)) return supplied.toLowerCase();
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase();
  } catch {
    return 'development-build';
  }
}

export default defineConfig({
  // Cloudflare serves this project at the origin root. Absolute bundle URLs
  // keep SPA fallbacks such as /play/neocity from resolving ./assets beneath
  // the deep route and receiving HTML in place of JavaScript.
  base: '/',
  plugins: [legalNotices()],
  define: {
    __XO_BUILD_HASH__: JSON.stringify(buildHash()),
  },
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
