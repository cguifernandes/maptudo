import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Gera dist/ pronto para "Carregar sem compactação": popup.html + popup.js + background.js
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    rolldownOptions: {
      input: { popup: 'popup.html', background: 'src/background.js' },
      output: { entryFileNames: '[name].js' },
    },
  },
});
