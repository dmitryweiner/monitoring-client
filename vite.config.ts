import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const WORKER_URL = 'https://home-monitoring-poc.dmitry-weiner.workers.dev';

/**
 * Content-Security-Policy for the deployed page. Not applied to `vite dev`,
 * where the dev server injects inline styles and a websocket client.
 */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' ${WORKER_URL}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    name: 'monitoring-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

export default defineConfig({
  // The site is served from https://<user>.github.io/monitoring-client/.
  base: '/monitoring-client/',
  plugins: [contentSecurityPolicy()],
  build: {
    // GitHub Pages is configured to publish `main:/docs`, so the build output
    // is committed to the repository.
    outDir: 'docs',
    emptyOutDir: true,
    // The build is committed to the repository, so a 400 kB source map would
    // land in the history on every deploy. Debug with `npm run dev` instead.
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    proxy: {
      // Development talks to the real Worker through this proxy. The Origin
      // header is removed so the Worker does not need localhost in
      // ALLOWED_ORIGINS, and no CORS preflight is involved.
      '/api': {
        target: WORKER_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin');
            proxyReq.removeHeader('referer');
          });
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
