import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../static/dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,  // 主 chunk 578KB (177KB gzip) — 正常范围
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: 'markdown-vendor',
              test: /node_modules[\\/](marked|katex|highlight\.js)[\\/]/,
              priority: 20,
            },
            {
              name: 'ui-vendor',
              test: /node_modules[\\/](@heroui|framer-motion|lucide-react|@ant-design)[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
