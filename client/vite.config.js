// vite.config.js
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  base: '/',

  plugins: [
    basicSsl(),
  ],

  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 600,
  },

  server: {
    port: 5173,
    host: true,  // Bind to 0.0.0.0 — makes app accessible on LAN (phone testing)
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:3000',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ws/, ''),
      },
    },
  },

  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.1'),
  },
});
