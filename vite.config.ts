import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { host: '0.0.0.0', proxy: { '/ws': { target: 'ws://127.0.0.1:3001', ws: true }, '/api': 'http://127.0.0.1:3001' } } });
