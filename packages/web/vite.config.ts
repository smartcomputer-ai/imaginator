import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

const SERVER = process.env.IMAGINATOR_SERVER_URL ?? 'http://localhost:4747';

/**
 * `/api/*` and `/assets/<id>[/thumb]` go to the Imaginator server. Note the
 * regex: `/assets` alone is the asset library *page* and must stay with the
 * SPA; only `/assets/<something>` is an image served by the API.
 */
const proxy: Record<string, ProxyOptions> = {
  '/api': {
    target: SERVER,
    changeOrigin: true,
    ws: false,
    // SSE (`/api/events`) is a long-lived streaming response: no timeouts, no buffering.
    timeout: 0,
    proxyTimeout: 0,
    configure(p) {
      p.on('proxyRes', (proxyRes) => {
        if ((proxyRes.headers['content-type'] ?? '').includes('text/event-stream')) {
          proxyRes.headers['cache-control'] = 'no-cache';
          proxyRes.headers['x-accel-buffering'] = 'no';
        }
      });
    },
  },
  '^/assets/.+': { target: SERVER, changeOrigin: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173, strictPort: false, proxy },
  preview: { port: 5173, proxy },
  build: {
    outDir: 'dist',
    // Not `assets/`: that path prefix belongs to the server's `/assets/:id` route.
    assetsDir: 'static',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router'],
          query: ['@tanstack/react-query'],
          core: ['@imaginator/core', 'zod'],
        },
      },
    },
  },
});
