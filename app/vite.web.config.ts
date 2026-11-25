// A interface sem o Electron: usada no navegador do celular e para testar telas no computador.
//   npm run web                      -> desenvolvimento, falando com o servidor local
//   npm run web -- --mode production -> desenvolvimento, falando com o servidor publicado
//   npm run build:web                -> gera server/public, publicado junto com o servidor
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  envDir: '../..',
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true, host: '0.0.0.0' },
  build: { outDir: '../../../server/public', emptyOutDir: true },
});
