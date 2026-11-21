import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Run tests against shared sources so they do not depend on a prior build.
    alias: { '@safi/shared': path.resolve(__dirname, 'shared/src/index.ts') },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    testTimeout: 20000,
  },
});
