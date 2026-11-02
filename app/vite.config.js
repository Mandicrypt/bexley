import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BASE_PATH is set by the GitHub Pages build (e.g. /bexley/).
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  // near-api-js pulls in a library that expects Node's `util`; give it the browser version.
  resolve: { alias: { util: 'util/' } },
  define: { 'process.env.NODE_DEBUG': 'false' },
  server: { fs: { allow: ['..'] } },
});
