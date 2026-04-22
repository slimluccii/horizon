import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/library': 'http://localhost:7777',
      '/sessions': { target: 'http://localhost:7777', ws: true },
      '/health': 'http://localhost:7777',
    },
  },
})
