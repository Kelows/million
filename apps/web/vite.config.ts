import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // bind to every interface so other devices on the LAN can reach the deck.
    // The API stays on localhost — requests arrive through this server's /api
    // proxy, so nothing else is exposed beyond the machine.
    host: true,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
