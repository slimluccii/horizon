import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Every backend endpoint lives under /api, so one proxy rule covers them all
    // (ws:true for the session WebSocket upgrade). Everything else is the SPA,
    // served by Vite — no more per-prefix rules that clashed with client routes
    // like /settings.
    proxy: {
      '/api': { target: 'http://localhost:7777', ws: true },
    },
  },
})
