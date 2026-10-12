import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` -> dist/ (static site). `npm run build:standalone` -> a single self-contained
// HTML file that can be opened directly from disk (file://) without any server.
const standalone = process.env.STANDALONE === '1';

export default defineConfig({
  base: './',
  plugins: standalone ? [viteSingleFile()] : [],
  build: { target: 'es2022', sourcemap: false, outDir: standalone ? 'standalone' : 'dist' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
} as any);
