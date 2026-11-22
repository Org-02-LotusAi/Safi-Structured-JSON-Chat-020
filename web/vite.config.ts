import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: proxy API calls to the HTTPS bridge (self-signed dev cert => secure:false).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: 'https://localhost:8443', secure: false, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          const pkg = /node_modules[\/](@[^\/]+[\/][^\/]+|[^\/]+)/.exec(id)?.[1] ?? '';
          if (['react', 'react-dom', 'scheduler'].includes(pkg)) return 'vendor-react';
          if (pkg.startsWith('@assistant-ui/')) return 'vendor-assistant-ui';
          // Small helpers used by the login screen too: keep them out of the assistant-ui chunk.
          if (['clsx', 'class-variance-authority', 'tailwind-merge', 'lucide-react'].includes(pkg)) return 'vendor-ui';
          return 'vendor-assistant-deps';
        },
      },
    },
  },
});
