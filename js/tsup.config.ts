import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: 'esm',
    dts: true,
    clean: true,
  },
  {
    // Client-only entries; the directive lets server components render them.
    entry: { react: 'src/react.tsx', nextjs: 'src/nextjs.tsx' },
    format: 'esm',
    dts: true,
    external: ['xwebmcp', 'xwebmcp/react', 'react', 'next'],
    banner: { js: "'use client';" },
  },
]);
