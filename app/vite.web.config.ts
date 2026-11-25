// Roda só a interface no navegador (sem Electron), para testar telas rapidamente.
// Com `--mode production` ela fala com o servidor publicado (.env.production).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  envDir: '../..',
  plugins: [react()],
  server: { port: 5173, strictPort: true, host: '0.0.0.0' },
});
