import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (file: string) => fileURLToPath(new URL(`./src/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^xwebmcp$/, replacement: src('index.ts') },
      { find: /^xwebmcp\/react$/, replacement: src('react.tsx') },
      { find: /^xwebmcp\/nextjs$/, replacement: src('nextjs.tsx') },
    ],
  },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost:3000/' } },
  },
});
