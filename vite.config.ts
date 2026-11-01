import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

// Tauri expects a fixed port and must not watch the Rust side.
export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: {
    target: 'es2021',
    chunkSizeWarningLimit: 900, // three.js, embedded locally
    rollupOptions: { input: ['index.html', 'island.html'] }, // widget + notch island windows
  },
});
