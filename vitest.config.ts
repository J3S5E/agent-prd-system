import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run test files sequentially to avoid database conflicts
    fileParallelism: false,
    // Increase default timeouts
    testTimeout: 600000,
    hookTimeout: 120000,
  },
});