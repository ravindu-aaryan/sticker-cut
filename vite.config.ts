import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative base so the build works from any sub-path (e.g. GitHub Pages).
  base: './',
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  worker: { format: 'es' },
  test: {
    environment: 'node',
  },
});
